import Providers from 'providers/providers';
import MediaController from 'program/media-controller';
import Promise, { resolved } from 'polyfills/promise';
import cancelable from 'utils/cancelable';
import { MediaControllerListener } from 'program/program-listeners';
import Eventable from 'utils/eventable';
import BackgroundMedia from 'program/background-media';

import { ERROR, PLAYER_STATE, STATE_BUFFERING } from 'events/events';
import { Features } from '../environment/environment';

/** @private Do not include in JSDocs */

class ProgramController extends Eventable {
    /**
     * ProgramController constructor
     * @param {Model} model - The player's model
     * @param {MediaElementPool} mediaPool - The player's media element pool
     */
    constructor(model, mediaPool) {
        super();

        this.adPlaying = false;
        this.background = BackgroundMedia();
        this.mediaPool = mediaPool;
        this.mediaController = null;
        this.mediaControllerListener = MediaControllerListener(model, this);
        this.model = model;
        this.providers = new Providers(model.getConfiguration());
        this.loadPromise = resolved;

        if (!Features.backgroundLoading) {
            // If background loading is not supported, set the shared media element
            model.set('mediaElement', this.mediaPool.getPrimedElement());
        }
    }

    /**
     * Activates a playlist item, loading it into the foreground.
     * This method will either load a new Provider or reuse the active one.
     * @param {number} index - The playlist index of the item
     * @returns {Promise} The Provider promise. Resolves with the active Media Controller
     * @memberOf ProgramController
     */
    setActiveItem(index) {
        const { background, mediaController, model } = this;
        const item = model.get('playlist')[index];

        model.attributes.itemReady = false;
        model.setActiveItem(index);
        const source = getSource(item);
        if (!source) {
            return Promise.reject(new Error('No media'));
        }

        // Activate the background media if it's loading the item we want to play
        if (background.isNext(item)) {
            // First destroy the active item so that the BGL provider can enter the foreground
            this._destroyActiveMedia();
            // Attach the BGL provider into the load/play chain
            this.loadPromise = this._activateBackgroundMedia();
            return this.loadPromise;
        }
        // Loading a new item invalidates all background loading media
        this._destroyBackgroundMedia();

        if (mediaController) {
            const casting = model.get('castActive');
            if (casting || this._providerCanPlay(mediaController.provider, source)) {
                // We can synchronously reuse the current mediaController
                this.loadPromise = Promise.resolve(mediaController);
                // Reinitialize the mediaController with the new item, allowing a new playback session
                mediaController.activeItem = item;
                this._setActiveMedia(mediaController);
                return this.loadPromise;
            }

            // If we can't play the source with the current provider, reset the current one and
            // prime the next tag within the gesture
            this._destroyActiveMedia();
        }

        const mediaModelContext = model.mediaModel;
        this.loadPromise = this._setupMediaController(source)
            .then(nextMediaController => {
                // Don't do anything if we've tried to load another provider while this promise was resolving
                // We check using the mediaModel because it is unique per item, and per instance of that item
                if (mediaModelContext === model.mediaModel) {
                    nextMediaController.activeItem = item;
                    this._setActiveMedia(nextMediaController);
                    return nextMediaController;
                }
            })
            .catch(err => {
                this._destroyActiveMedia();
                throw err;
            });
        return this.loadPromise;
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
            return Promise.reject(new Error('No media'));
        }

        if (!playReason) {
            playReason = model.get('playReason');
        }

        // Start playback immediately if we have already loaded a mediaController
        if (mediaController) {
            playPromise = mediaController.play(playReason);
        } else {
            // Wait for the provider to load before starting initial playback
            model.set(PLAYER_STATE, STATE_BUFFERING);

            // Make the subsequent promise cancelable so that we can avoid playback when no longer wanted
            const thenPlayPromise = cancelable((nextMediaController) => {
                if (this.mediaController && this.mediaController.mediaModel === nextMediaController.mediaModel) {
                    return nextMediaController.play(playReason);
                }
                throw new Error('Playback cancelled.');
            });

            playPromise = this.loadPromise
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
     * @returns {void}
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
     * @returns {void}
     */
    preloadVideo() {
        const { background, mediaController } = this;
        const media = mediaController || background.currentMedia;
        if (!media) {
            return;
        }
        media.preload();
    }

    /**
     * Pauses playback of the current video, and sets the player state to PAUSED.
     * @returns {void}
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
     * @param {CastProvider} castProvider - The playback provider instance (Casting is implemented in jwplayer-commercial).
     * @param {Item} item - The playlist Item instance to cast.
     * @returns {void}
     */
    castVideo(castProvider, item) {
        const { model } = this;
        model.attributes.itemReady = false;

        const playlistItem = Object.assign({}, item);
        playlistItem.starttime = model.mediaModel.get('position');

        const castMediaController = new MediaController(castProvider, model);
        castMediaController.activeItem = playlistItem;
        this._setActiveMedia(castMediaController);
    }

    /**
     * Stops casting. The Player is expected to restore video playback afterwards.
     * @returns {void}
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
     * @returns {void}
     */
    backgroundActiveMedia() {
        this.adPlaying = true;
        const { background, mediaController } = this;
        if (!mediaController) {
            return;
        }

        // Destroy any existing background media
        if (background.currentMedia) {
            this._destroyMediaController(background.currentMedia);
        }

        mediaController.background = true;
        background.currentMedia = mediaController;
        this.mediaController = null;
    }

    /**
     * Restores the background media to the foreground.
     * Its media element is reattached to the Player container.
     * We start listening to its events again.
     * @returns {void}
     */
    restoreBackgroundMedia() {
        this.adPlaying = false;
        const { background, mediaController } = this;
        const backgroundMediaController = background.currentMedia;
        if (!backgroundMediaController) {
            return;
        } else if (mediaController) {
            // An existing media controller means that we've changed the active item
            // The current background media is no longer relevant, so destroy it
            this._destroyMediaController(backgroundMediaController);
            background.currentMedia = null;
            return;
        }

        backgroundMediaController.mediaModel.attributes.mediaState = 'buffering';
        this._setActiveMedia(backgroundMediaController);
        backgroundMediaController.background = false;
        background.currentMedia = null;
    }

    /**
     * Loads the next playlist item in the background.
     * @param {Item} item - The playlist item to load.
     *
     * @returns {void}
     */
    backgroundLoad(item) {
        const { background } = this;
        const source = getSource(item);

        background.setNext(item, this._setupMediaController(source)
            .then(nextMediaController => {
                nextMediaController.activeItem = item;
                nextMediaController.preload();
                return nextMediaController;
            })
            .catch(() => {
                background.clearNext();
            })
        );
    }

    /**
     * Primes media elements so that they can autoplay without further user gesture.
     * A primed element is required for media to load in the background.
     * This method does not prime elements who already have a source set ("safe prime").
     * @returns {void}
     */
    primeMediaElements() {
        this.mediaPool.prime();
    }

    /**
     * Removes all event listeners and destroys all media.
     * @returns {void}
     */
    destroy() {
        this.off();
        this._destroyBackgroundMedia();
        this._destroyActiveMedia();
    }

    /**
     * Activates the provided media controller, placing it into the foreground.
     * Events fired from the media controller will be forwarded through the program controller.
     * @param {MediaController} mediaController - The media controller to activate.
     * @returns {void}
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
        model.set('itemReady', true);
    }

    /**
     * Destroys the active media controller and current playback.
     * @returns {void}
     * @private
     */
    _destroyActiveMedia() {
        const { mediaController, model } = this;
        if (!mediaController) {
            return;
        }

        mediaController.detach();
        this._destroyMediaController(mediaController);
        model.resetProvider();
        this.mediaController = null;
    }

    /**
     * Destroys all background media.
     * @returns {void}
     * @private
     */
    _destroyBackgroundMedia() {
        const { background } = this;
        this._destroyMediaController(background.currentMedia);
        background.currentMedia = null;
        this._destroyBackgroundLoadingMedia();
    }

    /**
     * Destroys a mediaController, and returns it's tag to the pool.
     * @param {MediaController} mediaController - The media controller to destroy and recycle.
     * @returns {void}
     * @private
     */
    _destroyMediaController(mediaController) {
        const { mediaPool } = this;
        if (!mediaController) {
            return;
        }
        mediaPool.recycle(mediaController.mediaElement);
        mediaController.destroy();
    }

    /**
     * Constructs a new media controller with the provider whose able to play the current source.
     * Will wait and load the provider constructor if it has not already been loaded.
     * If the required provider cannot be loaded, the subsequent promise rejection will destroy playback.
     * @param {Source} source - The playlist item Source for which a provider is needed.
     * @returns {Promise} The Provider constructor promise.
     * @private
     */
    _setupMediaController(source) {
        const { model, providers } = this;
        const makeMediaController = ProviderConstructor => new MediaController(
            new ProviderConstructor(model.get('id'), model.getConfiguration(), this.primedElement),
            model
        );

        const { provider, name } = providers.choose(source);
        if (provider) {
            return Promise.resolve(makeMediaController((provider)));
        }

        return providers.load(name)
            .then(ProviderConstructor => makeMediaController(ProviderConstructor));
    }

    /**
     * Places the background loading media into the foreground. Will wait for the provider promise to resolve.
     * If the program controller has been placed into ads mode, the background loading media will replace the background
     * loaded media. When the ad is over, the loaded media will be placed into the foreground via _restoreBackgroundMedia().
     * This is done to avoid a race condition where we have activated the loading item, but switch to ads mode before the
     * promise resovles, resulting in two tags in the foreground (since _backgroundActiveMedia "misses" the pending promise).
     * @returns {Promise} The Provider promise. Resolves with preloaded media controller.
     * @memberOf ProgramController
     */
    _activateBackgroundMedia() {
        const { background, background: { nextLoadPromise } } = this;
        // Activating this item means that any media already loaded in the background will no longer be needed
        this._destroyMediaController(background.currentMedia);
        background.currentMedia = null;
        return nextLoadPromise.then(nextMediaController => {
            if (!nextMediaController) {
                return;
            }
            background.clearNext();
            if (this.adPlaying) {
                background.currentMedia = nextMediaController;
            } else {
                this._setActiveMedia(nextMediaController);
                nextMediaController.background = false;
            }
            return nextMediaController;
        });
        // The catch is chained as part of the play promise chain
    }

    /**
     * Destroys the mediaController which was constructed and loading in the background (nextMedia).
     * Does not destroy the mediaController which was already playing and subsequently placed into the background (currentMedia).
     * @returns {void}
     * @private
     */
    _destroyBackgroundLoadingMedia() {
        const { background, background: { nextLoadPromise } } = this;
        if (!nextLoadPromise) {
            return;
        }
        nextLoadPromise.then(nextMediaController => {
            this._destroyMediaController(nextMediaController);
            background.clearNext();
        });
    }

    _providerCanPlay(_provider, source) {
        const { provider } = this.providers.choose(source);
        return provider && (_provider && _provider instanceof provider);
    }

    /**
     * Returns the active audio track index.
     * @returns {number} The active audio track index.
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
     * @returns {Array<AudioTrackOption>} An array of AudioTrackOption instances.
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
     * @returns {boolean} Is the "beforeComplete" event being propagated
     * or did it result in the media being detached or backgrounded?
     */
    get beforeComplete() {
        const { mediaController, background: { currentMedia } } = this;
        if (!mediaController && !currentMedia) {
            return false;
        }

        return mediaController ? mediaController.beforeComplete : currentMedia.beforeComplete;
    }

    /**
     * Returns a primed element from the media pool.
     * @returns {HTMLVideoElement|null} The first video element in the pool, or null if the pool is empty.
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
     * @returns {number} The active quality level index.
     */
    get quality() {
        if (!this.mediaController) {
            return -1;
        }

        return this.mediaController.quality;
    }

    /**
     * Returns the list of quality levels.
     * @returns {Array<QualityOption>} An array of QualityOption objects.
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
     * @param {boolean} shouldAttach - Attach or detach?
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
     * Sets the active audio index.
     * @param {number} index - The index of the audio track to select.
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
     * @param {boolean} mode - Activate or deactivate media controls?
     * @returns {void}
     * TODO: deprecate - only used by jwplayer-commercial flash provider
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
     * @param {boolean} mute - Mute or unmute media?
     * @returns {void}
     */
    set mute(mute) {
        const { background, mediaController, mediaPool } = this;

        if (mediaController) {
            mediaController.mute = mute;
        }
        if (background.currentMedia) {
            background.currentMedia.mute = mute;
        }

        mediaPool.syncMute(mute);
    }

    /**
     * Seeks the media to the provided position.
     * Set the item's starttime so that if detached while seeking it resumes from the correct time.
     * ALso set the item's starttime so that if we seek before loading, we load and begin at the correct time.
     * @param {number} pos - The position to start at or seek to.
     * @returns {void}
     */
    set position(pos) {
        const { mediaController } = this;
        if (!mediaController) {
            return;
        }

        mediaController.item.starttime = pos;
        if (mediaController.attached) {
            mediaController.position = pos;
        }
    }

    /**
     * Sets the current quality level.
     * @param {number} index - The index of the quality level to select.
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
     * @param {number} index - The index of the subtitle track to select.
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
     * @param {number} volume - A number from 0 to 1.
     * @returns {void}
     */
    set volume(volume) {
        const { background, mediaController, mediaPool } = this;

        if (mediaController) {
            mediaController.volume = volume;
        }
        if (background.currentMedia) {
            background.currentMedia.volume = volume;
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
