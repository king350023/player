import { Browser, OS } from 'environment/environment';
import SimpleModel from 'model/simplemodel';
import { INITIAL_PLAYER_STATE } from 'model/player-model';
import Providers from 'providers/providers';
import initQoe from 'controller/qoe';
import { PLAYER_STATE, STATE_IDLE, STATE_COMPLETE, STATE_BUFFERING, STATE_PAUSED, STATE_PLAYING,
    MEDIA_TYPE, PROVIDER_CHANGED, AUDIO_TRACKS, AUDIO_TRACK_CHANGED,
    MEDIA_PLAY_ATTEMPT, MEDIA_BUFFER, MEDIA_TIME, MEDIA_BUFFER_FULL, MEDIA_LEVELS, MEDIA_LEVEL_CHANGED,
    MEDIA_BEFORECOMPLETE, MEDIA_COMPLETE, MEDIA_META } from 'events/events';
import utils from 'utils/helpers';
import _ from 'utils/underscore';
import Events from 'utils/backbone.events';
import { resolved } from 'polyfills/promise';

// Represents the state of the player
const Model = function() {
    var _this = this;
    var _providers;
    var _provider;
    var _beforecompleted = false;
    var _attached = true;

    this.mediaController = Object.assign({}, Events);
    this.mediaModel = new MediaModel();

    initQoe(this);

    this.set('mediaModel', this.mediaModel);

    this.setup = function(config) {

        Object.assign(this.attributes, config, INITIAL_PLAYER_STATE);

        this.updateProviders();
        this.setAutoStart();

        return this;
    };

    this.getConfiguration = function() {
        return _.omit(this.clone(), ['mediaModel']);
    };

    this.updateProviders = function() {
        _providers = new Providers(this.getConfiguration());
    };

    function _videoEventHandler(type, data) {
        var evt = Object.assign({}, data, { type: type });
        var mediaModel = this.mediaModel;
        switch (type) {
            case 'flashThrottle':
                var throttled = (data.state !== 'resume');
                this.set('flashThrottle', throttled);
                this.set('flashBlocked', throttled);
                break;
            case 'flashBlocked':
                this.set('flashBlocked', true);
                return;
            case 'flashUnblocked':
                this.set('flashBlocked', false);
                return;
            case 'volume':
                this.set(type, data[type]);
                return;
            case 'mute':
                if (!this.get('autostartMuted')) {
                    // Don't persist mute state with muted autostart
                    this.set(type, data[type]);
                }
                return;
            case 'ratechange':
                var rate = data.playbackRate;
                // Check if its a generally usable rate.  Shaka changes rate to 0 when pause or buffering.
                if (rate > 0) {
                    this.set('playbackRate', rate);
                }
                return;
            case MEDIA_TYPE:
                if (mediaModel.get('mediaType') !== data.mediaType) {
                    mediaModel.set('mediaType', data.mediaType);
                    this.mediaController.trigger(type, evt);
                }
                return;
            case PLAYER_STATE:
                mediaModel.set('state', data.newstate);

                // This "return" is important because
                //  we are choosing to not propagate this event.
                //  Instead letting the master controller do so
                return;
            case MEDIA_BUFFER:
                this.set('buffer', data.bufferPercent);
            /* falls through */
            case MEDIA_META:
                var duration = data.duration;
                if (_.isNumber(duration) && !_.isNaN(duration)) {
                    mediaModel.set('duration', duration);
                    this.set('duration', duration);
                }
                var itemMeta = this.get('itemMeta');
                Object.assign(itemMeta, data.metadata);
                break;
            case MEDIA_BUFFER_FULL:
                // media controller
                mediaModel.change('playAttempt', (mediaModelChanged, playAttempt) => {
                    if (playAttempt) {
                        mediaModelChanged.off('playAttempt', null, this);
                        this.playVideo();
                    }
                }, this);
                this.setPlaybackRate(this.get('defaultPlaybackRate'));
                break;
            case MEDIA_TIME:
                mediaModel.set('position', data.position);
                this.set('position', data.position);
                if (_.isNumber(data.duration)) {
                    mediaModel.set('duration', data.duration);
                    this.set('duration', data.duration);
                }
                break;
            case PROVIDER_CHANGED:
                this.set('provider', _provider.getName());
                break;
            case MEDIA_LEVELS:
                this.setQualityLevel(data.currentQuality, data.levels);
                mediaModel.set('levels', data.levels);
                break;
            case MEDIA_LEVEL_CHANGED:
                this.setQualityLevel(data.currentQuality, data.levels);
                this.persistQualityLevel(data.currentQuality, data.levels);
                break;
            case MEDIA_COMPLETE:
                _beforecompleted = true;
                this.mediaController.trigger(MEDIA_BEFORECOMPLETE, evt);
                if (_attached) {
                    this.playbackComplete();
                }
                return;
            case AUDIO_TRACKS:
                this.setCurrentAudioTrack(data.currentTrack, data.tracks);
                mediaModel.set('audioTracks', data.tracks);
                break;
            case AUDIO_TRACK_CHANGED:
                this.setCurrentAudioTrack(data.currentTrack, data.tracks);
                break;
            case 'subtitlesTrackChanged':
                this.persistVideoSubtitleTrack(data.currentTrack, data.tracks);
                break;
            case 'visualQuality':
                var visualQuality = Object.assign({}, data);
                mediaModel.set('visualQuality', visualQuality);
                break;
            case 'autoplayFailed':
                this.set('autostartFailed', true);
                if (mediaModel.get('state') === STATE_PLAYING) {
                    mediaModel.set('state', STATE_PAUSED);
                }
                break;
            default:
                break;
        }

        this.mediaController.trigger(type, evt);
    }

    this.setQualityLevel = function(quality, levels) {
        if (quality > -1 && levels.length > 1) {
            this.mediaModel.set('currentLevel', parseInt(quality));

        }
    };

    this.persistQualityLevel = function(quality, levels) {
        var currentLevel = levels[quality] || {};
        var label = currentLevel.label;
        this.set('qualityLabel', label);
    };

    this.setCurrentAudioTrack = function(currentTrack, tracks) {
        if (currentTrack > -1 && tracks.length > 0 && currentTrack < tracks.length) {
            this.mediaModel.set('currentAudioTrack', parseInt(currentTrack));
        }
    };

    this.onMediaContainer = function() {
        var container = this.get('mediaContainer');
        _provider.setContainer(container);
    };

    this.changeVideoProvider = function(Provider) {
        this.off('change:mediaContainer', this.onMediaContainer);

        if (_provider) {
            _provider.off(null, null, this);
            if (_provider.getContainer()) {
                _provider.remove();
            }
            delete _provider.instreamMode;
        }

        if (!Provider) {
            this.resetProvider();
            this.set('provider', undefined);
            return;
        }

        _provider = new Provider(_this.get('id'), _this.getConfiguration());

        var container = this.get('mediaContainer');
        if (container) {
            _provider.setContainer(container);
        } else {
            this.once('change:mediaContainer', this.onMediaContainer);
        }

        if (_provider.getName().name.indexOf('flash') === -1) {
            this.set('flashThrottle', undefined);
            this.set('flashBlocked', false);
        }

        _provider.volume(_this.get('volume'));

        // Mute the video if autostarting on mobile. Otherwise, honor the model's mute value
        _provider.mute(this.autoStartOnMobile() || _this.get('mute'));

        _provider.on('all', _videoEventHandler, this);

        // Attempt setting the playback rate to be the user selected value
        this.setPlaybackRate(this.get('defaultPlaybackRate'));

        // Set playbackRate because provider support for playbackRate may have changed and not sent an update
        this.set('playbackRate', _provider.getPlaybackRate());

        if (this.get('instreamMode') === true) {
            _provider.instreamMode = true;
        }

        this.set('renderCaptionsNatively', _provider.renderNatively);
    };

    this.checkComplete = function() {
        return _beforecompleted;
    };

    this.detachMedia = function() {
        _attached = false;
        if (_provider) {
            _provider.off('all', _videoEventHandler, this);
            _provider.detachMedia();
        }
    };

    this.attachMedia = function() {
        _attached = true;
        if (_provider) {
            _provider.off('all', _videoEventHandler, this);
            _provider.on('all', _videoEventHandler, this);
        }
        if (_beforecompleted) {
            this.playbackComplete();
        }
        if (_provider) {
            _provider.attachMedia();
        }

        // Restore the playback rate to the provider in case it changed while detached and we reused a video tag.
        this.setPlaybackRate(this.get('defaultPlaybackRate'));
    };

    this.playbackComplete = function() {
        _beforecompleted = false;
        _provider.setState(STATE_COMPLETE);
        this.mediaController.trigger(MEDIA_COMPLETE, {});
    };

    this.destroy = function() {
        this.attributes._destroyed = true;
        this.off();
        if (_provider) {
            _provider.off(null, null, this);
            _provider.destroy();
        }
    };

    this.getVideo = function() {
        return _provider;
    };

    this.setFullscreen = function(state) {
        state = !!state;
        if (state !== _this.get('fullscreen')) {
            _this.set('fullscreen', state);
        }
    };

    // Give the option for a provider to be forced
    this.chooseProvider = function(source) {
        // if _providers.choose is null, something went wrong in filtering
        return _providers.choose(source).provider;
    };

    this.setItemIndex = function(index) {
        var playlist = this.get('playlist');

        // If looping past the end, or before the beginning
        index = parseInt(index, 10) || 0;
        index = (index + playlist.length) % playlist.length;

        this.set('item', index);
        this.setActiveItem(playlist[index]);
    };

    this.setActiveItem = function(item) {
        // Item is actually changing
        this.mediaModel.off();
        this.mediaModel = new MediaModel();
        this.set('itemMeta', {});
        this.set('mediaModel', this.mediaModel);
        this.set('position', item.starttime || 0);
        this.set('minDvrWindow', item.minDvrWindow);
        this.set('duration', (item.duration && utils.seconds(item.duration)) || 0);
        this.attributes.playlistItem = null;
        this.set('playlistItem', item);
        this.setProvider(item);
    };

    this.setProvider = function(item) {
        var source = item && item.sources && item.sources[0];
        if (source === undefined) {
            // source is undefined when resetting index with empty playlist
            return;
        }

        var provider = this.chooseProvider(source);
        // If we are changing video providers
        if (!provider || !(_provider && _provider instanceof provider)) {
            _this.changeVideoProvider(provider);
        }

        if (!_provider) {
            return;
        }

        // this allows the providers to preload
        if (_provider.init) {
            _provider.init(item);
        }

        // Set the Provider after calling init because some Provider properties are only set afterwards
        this.set('provider', _provider.getName());

        // Listening for change:item won't suffice when loading the same index or file
        // We also can't listen for change:mediaModel because it triggers whether or not
        //  an item was actually loaded
        this.trigger('itemReady', item);
    };

    this.getProviders = function() {
        return _providers;
    };

    this.resetProvider = function() {
        _provider = null;
    };

    this.setVolume = function(volume) {
        volume = Math.round(volume);
        this.set('volume', volume);
        if (_provider) {
            _provider.volume(volume);
        }
        var mute = (volume === 0);
        if (mute !== (this.getMute())) {
            this.setMute(mute);
        }
    };

    this.getMute = function() {
        return this.get('autostartMuted') || this.get('mute');
    };

    this.setMute = function(mute) {
        if (!utils.exists(mute)) {
            mute = !(this.getMute());
        }
        this.set('mute', mute);
        if (_provider) {
            _provider.mute(mute);
        }
        if (!mute) {
            var volume = Math.max(10, this.get('volume'));
            this.set('autostartMuted', false);
            this.setVolume(volume);
        }
    };

    this.setStreamType = function(streamType) {
        this.set('streamType', streamType);
        if (streamType === 'LIVE') {
            this.setPlaybackRate(1);
        }
    };

    this.setPlaybackRate = function(playbackRate) {
        if (!_attached || !_.isNumber(playbackRate)) {
            return;
        }

        // Clamp the rate between 0.25x and 4x
        playbackRate = utils.between(playbackRate, 0.25, 4);

        if (this.get('streamType') === 'LIVE') {
            playbackRate = 1;
        }

        this.set('defaultPlaybackRate', playbackRate);

        if (_provider && _provider.setPlaybackRate) {
            _provider.setPlaybackRate(playbackRate);
        }
    };

    // The model is also the mediaController for now
    this.loadVideo = function(item, playReason) {
        if (!item) {
            item = this.get('playlist')[this.get('item')];
        }
        if (!playReason) {
            playReason = this.get('playReason');
        }
        this.set('position', item.starttime || 0);
        this.set('duration', (item.duration && utils.seconds(item.duration)) || 0);
        this.mediaModel.set('playAttempt', true);

        this.mediaController.trigger(MEDIA_PLAY_ATTEMPT, { playReason: playReason });

        if (_provider) {
            _provider.load(item);
            return resolved;
        }
        this.set('state', STATE_BUFFERING);
        const providerNeeded = _providers.required([item]);
        return _providers.load(providerNeeded).then(() => {
            if (!_provider && _attached && this.get('playlist')[this.get('item')].file === item.file) {
                this.setProvider(item);
                _provider.load(item);
                return resolved;
            }
        });
    };

    this.stopVideo = function() {
        this.mediaModel.set('playAttempt', false);
        if (_provider) {
            _provider.stop();
        }
    };

    this.playVideo = function() {
        const playPromise = _provider.play();
        if (!playPromise) {
            // TODO: polyfill video tag play promise
            return resolved;
        }
        return playPromise;
    };

    this.persistCaptionsTrack = function() {
        var track = this.get('captionsTrack');

        if (track) {
            // update preference if an option was selected
            this.set('captionLabel', track.name);
        } else {
            this.set('captionLabel', 'Off');
        }
    };


    this.setVideoSubtitleTrack = function(trackIndex, tracks) {
        this.set('captionsIndex', trackIndex);
        /*
         * Tracks could have changed even if the index hasn't.
         * Need to ensure track has data for captionsrenderer.
         */
        if (trackIndex && tracks && trackIndex <= tracks.length && tracks[trackIndex - 1].data) {
            this.set('captionsTrack', tracks[trackIndex - 1]);
        }

        if (_provider && _provider.setSubtitlesTrack) {
            _provider.setSubtitlesTrack(trackIndex);
        }
    };

    this.persistVideoSubtitleTrack = function(trackIndex, tracks) {
        this.setVideoSubtitleTrack(trackIndex, tracks);
        this.persistCaptionsTrack();
    };

    function _autoStartSupportedIOS() {
        if (!OS.iOS) {
            return false;
        }
        // Autostart only supported in iOS 10 or higher - check if the version is 9 or less
        return OS.version.major >= 10;
    }

    function platformCanAutostart() {
        var autostartAdsIsEnabled = (!_this.get('advertising') || _this.get('advertising').autoplayadsmuted);
        var iosBrowserIsSupported = _autoStartSupportedIOS() && (Browser.safari || Browser.chrome || Browser.facebook);
        var androidBrowserIsSupported = OS.android && Browser.chrome;
        var mobileBrowserIsSupported = (iosBrowserIsSupported || androidBrowserIsSupported);
        var isAndroidSdk = _this.get('sdkplatform') === 1;
        return (!_this.get('sdkplatform') && autostartAdsIsEnabled && mobileBrowserIsSupported) || isAndroidSdk;
    }

    this.autoStartOnMobile = function() {
        return this.get('autostart') && platformCanAutostart();
    };

    // Mobile players always wait to become viewable.
    // Desktop players must have autostart set to viewable
    this.setAutoStart = function(autoStart) {
        if (autoStart !== undefined) {
            this.set('autostart', autoStart);
        }

        const autoStartOnMobile = this.autoStartOnMobile();
        if (autoStartOnMobile) {
            this.set('autostartMuted', true);
        }
        this.set('playOnViewable', autoStartOnMobile || this.get('autostart') === 'viewable');
    };
};

// Represents the state of the provider/media element
const MediaModel = Model.MediaModel = function() {
    this.set('state', STATE_IDLE);
};

Object.assign(Model.prototype, SimpleModel);
Object.assign(MediaModel.prototype, SimpleModel);

export default Model;
