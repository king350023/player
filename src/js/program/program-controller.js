import ProviderController from 'providers/provider-controller';
import MediaController from 'program/media-controller';
import Promise, { resolved } from 'polyfills/promise';
import cancelable from 'utils/cancelable';
import { MediaControllerListener } from 'program/program-listeners';
import Eventable from 'utils/eventable';

import { ERROR, PLAYER_STATE, STATE_BUFFERING } from 'events/events';
import { Features } from '../environment/environment';

/** @private Do not include in JSDocs */

class ProgramController extends Eventable {
    /**
     * ProgramController constructor
     * @param model
     * @param mediaPool
     */
    constructor(model, mediaPool) {
        super();

        this.backgroundMedia = null;
        this.mediaPool = mediaPool;
        this.mediaController = null;
        this.mediaControllerListener = MediaControllerListener(model, this);
        this.model = model;
        this.providerController = ProviderController(model.getConfiguration());
        this.providerPromise = resolved;

        if (!Features.backgroundLoading) {
            // If background loading is not supported, set the shared media element
            model.set('mediaElement', this.mediaPool.getPrimedElement());
        }
    }

    /**
     * Activates a playlist item, loading it into the foreground.
     * This method will either load a new Provider or reuse the active one.
     * @param {number} index - The playlist index of the item
     * @returns {Promise} - The Provider promise. Resolves with the active Media Controller
     * @memberOf ProgramController
     */
    setActiveItem(index) {
        const { mediaController, model } = this;
        const item = model.get('playlist')[index];

        model.attributes.itemReady = false;
        model.setActiveItem(index);
        this._destroyBackgroundMedia();
        const source = getSource(item);
        if (!source) {
            return Promise.reject('No media');
        }

        if (mediaController) {
            const casting = model.get('castActive');
            // Buffer between item switches, but remain in the initial state (IDLE) while loading the first provider
            model.set(PLAYER_STATE, STATE_BUFFERING);
            if (casting || this.providerController.canPlay(mediaController.provider, source)) {
                this.providerPromise = Promise.resolve(mediaController);
                // We can reuse the current mediaController and do so synchronously
                // Initialize the provider and mediaModel, sync it with the Model
                // This sets up the mediaController and allows playback to begin
                mediaController.activeItem = item;
                this._setActiveMedia(mediaController);
                // Initialize the provider last so it's setting properties on the (newly) active media model
                mediaController.provider.init(item);
                model.set('itemReady', true);
                return this.providerPromise;
            }

            // If we can't play the source with the current provider, reset the current one and
            // prime the next tag within the gesture
            this._destroyActiveMedia();
        }

        const mediaModelContext = model.mediaModel;
        this.providerPromise = this._loadProviderConstructor(source)
            .then((ProviderConstructor) => {
                // Don't do anything if we've tried to load another provider while this promise was resolving
                if (mediaModelContext === model.mediaModel) {
                    const nextProvider = new ProviderConstructor(model.get('id'), model.getConfiguration(), this.primedElement);
                    const nextMediaController = new MediaController(nextProvider, model);
                    nextMediaController.activeItem = item;
                    this._setActiveMedia(nextMediaController);
                    // Initialize the provider last so it's setting properties on the (newly) active media model
                    nextMediaController.provider.init(item);
                    model.set('itemReady', true);
                    return nextMediaController;
                }
            });
        return this.providerPromise;
    }

    /**
     * Plays the active item.
     * Will wait for the Provider promise to resolve before any play attempt.
     * @param {string} playReason - The reason playback is beginning.
     * @returns {Promise} The Play promise. Resolves when playback begins; rejects upon failure.
     */
    playVideo(playReason) {
        const { mediaController, model } = this;
        const item = model.get('playlistItem');
        let playPromise;

        if (!item) {
            return;
        }

        if (!playReason) {
            playReason = model.get('playReason');
        }

        // Start playback immediately if we have already loaded a mediaController
        if (mediaController) {
            playPromise = mediaController.play(playReason);
        } else {
            // Wait for the provider to load before starting initial playback
            // Make the subsequent promise cancelable so that we can avoid playback when no longer wanted
            const thenPlayPromise = cancelable((nextMediaController) => {
                // Ensure that we haven't switched items while waiting for the provider to load
                if (this.mediaController && this.mediaController.mediaModel === nextMediaController.mediaModel) {
                    return nextMediaController.play(playReason);
                }
                throw new Error('Playback cancelled.');
            });

            playPromise = this.providerPromise
                .catch(error => {
                    thenPlayPromise.cancel();
                    // Required provider was not loaded
                    model.trigger(ERROR, {
                        message: `Could not play video: ${error.message}`,
                        error: error
                    });
                    // Fail the playPromise to trigger "playAttemptFailed"
                    throw error;
                })
                .then(thenPlayPromise.async);
        }

        return playPromise;
    }

    /**
     * Stops playback of the active item, and sets the player state to IDLE.
     * @returns {undefined}
     */
    stopVideo() {
        const { mediaController, model } = this;

        const item = model.get('playlist')[model.get('item')];
        model.attributes.playlistItem = item;
        model.resetItem(item);

        if (mediaController) {
            mediaController.stop();
        }
    }

    /**
     * Preloads the active item, which loads and buffers some content.
     * @returns {undefined}
     */
    preloadVideo() {
        const { backgroundMedia, mediaController } = this;
        const media = mediaController || backgroundMedia;
        if (!media) {
            return;
        }
        media.preload();
    }

    /**
     * Pauses playback of the current video, and sets the player state to PAUSED.
     * @returns {undefined}
     */
    pause() {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.pause();
    }

    /**
     * Casts a video. The Cast Controller will control the Cast Provider.
     * @returns {undefined}
     */
    castVideo(castProvider, item) {
        const { model } = this;
        model.attributes.itemReady = false;

        const playlistItem = Object.assign({}, item);
        playlistItem.starttime = model.mediaModel.get('position');

        const castMediaController = new MediaController(castProvider, model);
        castMediaController.activeItem = playlistItem;
        this._setActiveMedia(castMediaController);
        // Initialize the provider last so it's setting properties on the (newly) active media model
        castMediaController.provider.init(playlistItem);
        model.set('itemReady', true);
    }

    /**
     * Stops casting. The Player is expected to restore video playback afterwards.
     * @returns {undefined}
     */
    stopCast() {
        const { model } = this;
        const index = model.get('item');
        const item = model.get('playlist')[index];

        item.starttime = model.mediaModel.get('position');

        this.stopVideo();

        this.setActiveItem(index);
    }

    /**
     * Places the currently active Media Controller into the background.
     * The media is still attached to a media element, but is removed from the Player's container.
     * Background media still emits events, but we stop listening to them.
     * Background media can (and will) be updated via it's API.
     * @returns {undefined}
     */
    backgroundActiveMedia() {
        const { backgroundMedia, mediaController } = this;
        if (!mediaController) {
            return;
        }

        // Destroy any existing background media
        if (backgroundMedia) {
            this._destroyBackgroundMedia();
        }

        mediaController.background = true;
        this.backgroundMedia = mediaController;
        this.mediaController = null;
    }

    /**
     * Restores the background media to the foreground.
     * Its media element is reattached to the Player container.
     * We start listening to its events again.
     * @returns {undefined}
     */
    restoreBackgroundMedia() {
        const { backgroundMedia, mediaController } = this;
        // An existing media controller means that we've changed the active item
        // The current background media is no longer relevant, so destroy it
        if (mediaController) {
            this._destroyBackgroundMedia();
            return;
        }
        if (backgroundMedia) {
            this._setActiveMedia(backgroundMedia);
            backgroundMedia.background = false;
            this.backgroundMedia = null;
        }
    }

    /**
     * Primes media elements so that they can autoplay without further user gesture.
     * A primed element is required for media to load in the background.
     * @returns {undefined}
     */
    primeMediaElements() {
        if (!Features.backgroundLoading) {
            // If background loading is not supported, the model will always contain the shared media element
            // Prime it so that playback after changing the active item does not require further gestures
            const { model } = this;
            const mediaElement = model.get('mediaElement');
            mediaElement.load();
        }
        this.mediaPool.prime();
    }

    /**
     * Removes all event listeners and destroys all media.
     * @returns {undefined}
     */
    destroy() {
        this.off();
        this._destroyBackgroundMedia();
        this._destroyActiveMedia();
    }

    /**
     * Activates the provided media controller, placing it into the foreground.
     * @returns {undefined}
     * @private
     */
    _setActiveMedia(mediaController) {
        const { model } = this;
        const { mediaModel, provider } = mediaController;

        assignMediaContainer(model, mediaController);
        this.mediaController = mediaController;

        model.set('mediaElement', mediaController.mediaElement);
        model.setMediaModel(mediaModel);
        model.setProvider(provider);

        forwardEvents(this, mediaController);
    }

    /**
     * Destroys the active media controller and current playback.
     * @returns {undefined}
     * @private
     */
    _destroyActiveMedia() {
        const { mediaPool, mediaController, model } = this;
        if (!mediaController) {
            return;
        }

        mediaController.detach();
        mediaPool.recycle(mediaController.mediaElement);
        mediaController.destroy();

        model.resetProvider();
        this.mediaController = null;
    }

    /**
     * Destroys background media.
     * @returns {undefined}
     * @private
     */
    _destroyBackgroundMedia() {
        const { backgroundMedia, mediaPool } = this;
        if (!backgroundMedia) {
            return;
        }
        mediaPool.recycle(backgroundMedia.mediaElement);
        backgroundMedia.destroy();
        this.backgroundMedia = null;
    }

    /**
     * Loads the constructor required for the current source.
     * Resolves with the required constructor, or rejects when the constructor could not be found or loaded.
     * If rejected, current playback will be destroyed.
     * @returns {Promise} - The Provider constructor promise.
     * @private
     */
    _loadProviderConstructor(source) {
        const { model, providerController } = this;

        let ProviderConstructor = providerController.choose(source);
        if (ProviderConstructor) {
            return Promise.resolve(ProviderConstructor);
        }

        return providerController.loadProviders(model.get('playlist'))
            .then(() => {
                ProviderConstructor = providerController.choose(source);
                // The provider we need couldn't be loaded
                if (!ProviderConstructor) {
                    this._destroyActiveMedia();
                    throw Error(`Failed to load media`);
                }
                return ProviderConstructor;
            });
    }

    /**
     * Returns the actively playing Provider object.
     * Will return the background Provider if there is no media in the foreground, which happens when an ad
     * is playing.
     * @returns {object}
     */
    get activeProvider() {
        const { mediaController, backgroundMedia } = this;
        if (!mediaController && !backgroundMedia) {
            return null;
        }

        return mediaController ? mediaController.provider : backgroundMedia.provider;
    }

    /**
     * Returns the active audio track index.
     * @returns {number}
     */
    get audioTrack() {
        const { mediaController } = this;
        if (!mediaController) {
            return -1;
        }

        return mediaController.audioTrack;
    }

    /**
     * Returns the list of audio tracks.
     * @returns {Array<object>}
     */
    get audioTracks() {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        return mediaController.audioTracks;
    }

    /**
     * Returns whether the current media has completed playback.
     * @returns {boolean}
     */
    get beforeComplete() {
        const { mediaController, backgroundMedia } = this;
        if (!mediaController && !backgroundMedia) {
            return;
        }

        return mediaController ? mediaController.beforeComplete : backgroundMedia.beforeComplete;
    }

    /**
     * Returns a primed element from the media pool.
     * @returns {Element|undefined}
     */
    get primedElement() {
        if (!Features.backgroundLoading) {
            // If background loading is not supported, the model will always contain the shared media element
            // Prime it so that playback after changing the active item does not require further gestures
            const { model } = this;
            return model.get('mediaElement');
        }
        return this.mediaPool.getPrimedElement();
    }

    /**
     * Returns the active quality index.
     * @returns {number}
     */
    get quality() {
        if (!this.mediaController) {
            return -1;
        }

        return this.mediaController.quality;
    }

    /**
     * Returns the list of quality levels.
     * @returns {Array<object>}
     */
    get qualities() {
        const { mediaController } = this;
        if (!mediaController) {
            return null;
        }

        return mediaController.qualities;
    }

    /**
     * Attaches or detaches the current media
     * @param {boolean} shouldAttach
     * @returns {void}
     */
    set attached(shouldAttach) {
        const { mediaController } = this;

        if (!mediaController) {
            return;
        }

        if (shouldAttach) {
            mediaController.attach();
        } else {
            mediaController.detach();
        }
    }

    /**
     * Returns the active quality index.
     * @param {number} index
     * @returns {void}
     */
    set audioTrack(index) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.audioTrack = parseInt(index, 10) || 0;
    }

    /**
     * Activates or deactivates media controls.
     * @param {boolean} mode
     * @returns {void}
     */
    set controls(mode) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.controls = mode;
    }

    /**
     * Mutes or unmutes the activate media.
     * Syncs across all media elements.
     * @param {boolean} mute
     * @returns {void}
     */
    set mute(mute) {
        const { backgroundMedia, mediaController, mediaPool } = this;

        if (mediaController) {
            mediaController.mute = mute;
        }
        if (backgroundMedia) {
            backgroundMedia.mute = mute;
        }

        mediaPool.syncMute(mute);
    }

    /**
     * Seeks the media to the provided position.
     * If the media is not attached, set the item's starttime, so that when reattaching, it resumes at that time.
     * @param {number} pos
     * @returns {void}
     */
    set position(pos) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        if (mediaController.attached) {
            mediaController.position = pos;
        } else {
            mediaController.item.starttime = pos;
        }
    }

    /**
     * Sets the current quality level.
     * @param {number} index
     * @returns {void}
     */
    set quality(index) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.quality = parseInt(index, 10) || 0;
    }

    /**
     * Sets the current subtitles track.
     * @param {number} index
     * @returns {void}
     */
    set subtitles(index) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.subtitles = index;
    }

    /**
     * Sets the volume level.
     * Syncs across all media elements.
     * @param {number} volume
     * @returns {void}
     */
    set volume(volume) {
        const { backgroundMedia, mediaController, mediaPool } = this;

        if (mediaController) {
            mediaController.volume = volume;
        }
        if (backgroundMedia) {
            backgroundMedia.volume = volume;
        }

        mediaPool.syncVolume(volume);
    }
}

function assignMediaContainer(model, mediaController) {
    const container = model.get('mediaContainer');
    if (container) {
        mediaController.container = container;
    } else {
        model.once('change:mediaContainer', (changedModel, changedContainer) => {
            mediaController.container = changedContainer;
        });
    }
}

function forwardEvents(programController, mediaController) {
    mediaController.off('all', programController.mediaControllerListener, programController);
    mediaController.on('all', programController.mediaControllerListener, programController);
}

function getSource(item) {
    return item && item.sources && item.sources[0];
}

export default ProgramController;
