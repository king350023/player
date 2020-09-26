import { loadFile, cancelXhr, convertToVTTCues } from 'controller/tracks-loader';
import { createId, createLabel } from 'controller/tracks-helper';
import { parseID3 } from 'providers/utils/id3Parser';
import { Browser } from 'environment/environment';
import { MEDIA_META, WARNING } from 'events/events';
import { findWhere, each, filter } from 'utils/underscore';

// Used across all providers for loading tracks and handling browser track-related events
const Tracks = {
    _itemTracks: null,
    _textTracks: null,
    _tracksById: null,
    _cuesByTrackId: null,
    _cachedVTTCues: null,
    _metaCuesByTextTime: null,
    _currentTextTrackIndex: -1,
    _unknownCount: 0,
    _activeCues: null,
    _initTextTracks,
    addTracksListener,
    clearTracks,
    clearMetaCues,
    clearCueData,
    disableTextTrack,
    enableTextTrack,
    getSubtitlesTrack,
    removeTracksListener,
    addTextTracks,
    setTextTracks,
    setupSideloadedTracks,
    setSubtitlesTrack,
    textTrackChangeHandler: null,
    addTrackHandler: null,
    addCuesToTrack,
    addCaptionsCue,
    addVTTCue,
    addVTTCuesToTrack,
    triggerActiveCues,
    renderNatively: false
};

function setTextTracks(tracks) {
    this._currentTextTrackIndex = -1;
    if (!tracks) {
        return;
    }

    if (!this._textTracks) {
        this._initTextTracks();
    } else {
        // Remove the 608 captions track that was mutated by the browser
        this._unknownCount = 0;
        this._textTracks = this._textTracks.filter(function(track) {
            const trackId = track._id;
            if (this.renderNatively && trackId && trackId.indexOf('nativecaptions') === 0) {
                delete this._tracksById[trackId];
                return false;
            } else if (track.name && track.name.indexOf('Unknown') === 0) {
                this._unknownCount++;
            }
            return true;
        }, this);

        // Remove the ID3 track from the cache
        delete this._tracksById.nativemetadata;
    }

    // filter for 'subtitles' or 'captions' tracks
    if (tracks.length) {
        let i = 0;
        const len = tracks.length;

        for (i; i < len; i++) {
            const track = tracks[i];
            if (!track._id) {
                if (track.kind === 'captions' || track.kind === 'metadata') {
                    track._id = 'native' + track.kind + i;
                    if (!track.label && track.kind === 'captions') {
                        // track label is read only in Safari
                        // 'captions' tracks without a label need a name in order for the cc menu to work
                        const labelInfo = createLabel(track, this._unknownCount);
                        track.name = labelInfo.label;
                        this._unknownCount = labelInfo.unknownCount;
                    }
                } else {
                    track._id = createId(track, this._textTracks.length);
                }
                if (this._tracksById[track._id]) {
                    // tracks without unique ids must not be marked as "inuse"
                    continue;
                }
                track.inuse = true;
            }
            if (!track.inuse || this._tracksById[track._id]) {
                continue;
            }
            // setup TextTrack
            if (track.kind === 'metadata') {
                // track mode needs to be "hidden", not "showing", so that cues don't display as captions in Firefox
                track.mode = 'hidden';
                track.oncuechange = _cueChangeHandler.bind(this);
                this._tracksById[track._id] = track;
            } else if (_kindSupported(track.kind)) {
                const mode = track.mode;
                let cue;

                // By setting the track mode to 'hidden', we can determine if the track has cues
                track.mode = 'hidden';

                if (!track.cues.length && track.embedded) {
                    // There's no method to remove tracks added via: video.addTextTrack.
                    // This ensures the 608 captions track isn't added to the CC menu until it has cues
                    continue;
                }

                track.mode = mode;

                // Parsed cues may not have been added to this track yet
                if (this._cuesByTrackId[track._id] && !this._cuesByTrackId[track._id].loaded) {
                    const cues = this._cuesByTrackId[track._id].cues;
                    while ((cue = cues.shift())) {
                        _addCueToTrack(this.renderNatively, track, cue);
                    }
                    track.mode = mode;
                    this._cuesByTrackId[track._id].loaded = true;
                }

                _addTrackToList.call(this, track);
            }
        }
    }

    if (this.renderNatively) {
        // Only bind and set this.textTrackChangeHandler once so that removeEventListener works
        this.textTrackChangeHandler = this.textTrackChangeHandler || textTrackChangeHandler.bind(this);
        this.addTracksListener(this.video.textTracks, 'change', this.textTrackChangeHandler);

        if (Browser.edge || Browser.firefox || Browser.safari) {
            // Listen for TextTracks added to the videotag after the onloadeddata event in Edge and Firefox
            this.addTrackHandler = this.addTrackHandler || addTrackHandler.bind(this);
            this.addTracksListener(this.video.textTracks, 'addtrack', this.addTrackHandler);
        }
    }

    if (this._textTracks.length) {
        this.trigger('subtitlesTracks', { tracks: this._textTracks });
    }
}

function setupSideloadedTracks(itemTracks) {
    // Add tracks if we're starting playback or resuming after a midroll

    if (!this.renderNatively) {
        return;
    }
    // Determine if the tracks are the same and the embedded + sideloaded count = # of tracks in the controlbar
    const alreadyLoaded = itemTracks === this._itemTracks;
    if (!alreadyLoaded) {
        cancelXhr(this._itemTracks);
    }
    this._itemTracks = itemTracks;
    if (!itemTracks) {
        return;
    }

    if (!alreadyLoaded) {
        this.disableTextTrack();
        _clearSideloadedTextTracks.call(this);
        this.addTextTracks(itemTracks);
    }
}

function getSubtitlesTrack() {
    return this._currentTextTrackIndex;
}

function setSubtitlesTrack(menuIndex) {
    if (!this.renderNatively) {
        if (this.setCurrentSubtitleTrack) {
            this.setCurrentSubtitleTrack(menuIndex - 1);
        }
        return;
    }

    if (!this._textTracks) {
        return;
    }

    // 0 = 'Off'
    if (menuIndex === 0) {
        this._textTracks.forEach(function (track) {
            track.mode = track.embedded ? 'hidden' : 'disabled';
        });
    }

    // Track index is 1 less than controlbar index to account for 'Off' = 0.
    // Prevent unnecessary track change events
    if (this._currentTextTrackIndex === menuIndex - 1) {
        return;
    }

    // Turn off current track
    this.disableTextTrack();

    // Set the provider's index to the model's index, then show the selected track if it exists
    this._currentTextTrackIndex = menuIndex - 1;

    if (this._textTracks[this._currentTextTrackIndex]) {
        this._textTracks[this._currentTextTrackIndex].mode = 'showing';
    }

    // Update the model index since the track change may have come from a browser event
    this.trigger('subtitlesTrackChanged', {
        currentTrack: this._currentTextTrackIndex + 1,
        tracks: this._textTracks
    });
}

function addCaptionsCue(cueData) {
    if (!cueData.text || !cueData.begin || !cueData.end) {
        return;
    }
    const trackId = cueData.trackid.toString();
    let track = this._tracksById && this._tracksById[trackId];
    if (!track) {
        track = {
            kind: 'captions',
            _id: trackId,
            data: []
        };
        this.addTextTracks([track]);
        this.trigger('subtitlesTracks', { tracks: this._textTracks });
    }

    let cueId;

    if (cueData.useDTS) {
        // There may not be any 608 captions when the track is first created
        // Need to set the source so position is determined from metadata
        if (!track.source) {
            track.source = cueData.source || 'mpegts';
        }

    }
    cueId = cueData.begin + '_' + cueData.text;

    let cue = this._metaCuesByTextTime[cueId];
    if (!cue) {
        cue = {
            begin: cueData.begin,
            end: cueData.end,
            text: cueData.text
        };
        this._metaCuesByTextTime[cueId] = cue;
        const vttCue = convertToVTTCues([cue])[0];
        track.data.push(vttCue);
    }
}

function addVTTCue(cueData, cacheKey) {
    if (!this._tracksById) {
        this._initTextTracks();
    }

    const trackId = cueData.track ? cueData.track : 'native' + cueData.type;
    let track = this._tracksById[trackId];
    const label = cueData.type === 'captions' ? 'Unknown CC' : 'ID3 Metadata';
    const vttCue = cueData.cue;

    if (!track) {
        const itemTrack = {
            kind: cueData.type,
            _id: trackId,
            label: label,
            embedded: true
        };

        track = _createTrack.call(this, itemTrack);

        if (this.renderNatively || track.kind === 'metadata') {
            this.setTextTracks(this.video.textTracks);
        } else {
            addTextTracks.call(this, [track]);
        }
    }
    if (_cacheVTTCue.call(this, track, vttCue, cacheKey)) {
        if (this.renderNatively || track.kind === 'metadata') {
            _addCueToTrack(this.renderNatively, track, vttCue);
        } else {
            track.data.push(vttCue);
        }
        return vttCue;
    }
    return null;
}

function addCuesToTrack(cueData) {
    // convert cues coming from the flash provider into VTTCues, then append them to track
    const track = this._tracksById[cueData.name];
    if (!track) {
        return;
    }

    track.source = cueData.source;
    const cues = cueData.captions || [];
    const cuesToConvert = [];
    let sort = false;

    for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const cueId = cueData.name + '_' + cue.begin + '_' + cue.end;
        if (!this._metaCuesByTextTime[cueId]) {
            this._metaCuesByTextTime[cueId] = cue;
            cuesToConvert.push(cue);
            sort = true;
        }
    }
    if (sort) {
        cuesToConvert.sort(function(a, b) {
            return a.begin - b.begin;
        });
    }
    const vttCues = convertToVTTCues(cuesToConvert);
    Array.prototype.push.apply(track.data, vttCues);
}

function addTracksListener(tracks, eventType, handler) {
    if (!tracks) {
        return;
    }
    // Always remove existing listener
    removeTracksListener(tracks, eventType, handler);

    if (this.instreamMode) {
        return;
    }

    if (tracks.addEventListener) {
        tracks.addEventListener(eventType, handler);
    } else {
        tracks['on' + eventType] = handler;
    }
}

function removeTracksListener(tracks, eventType, handler) {
    if (!tracks) {
        return;
    }
    if (tracks.removeEventListener) {
        tracks.removeEventListener(eventType, handler);
    } else {
        tracks['on' + eventType] = null;
    }
}

function clearMetaCues() {
    const metadataTrack = this._tracksById && this._tracksById.nativemetadata;
    if (metadataTrack) {
        _removeCues(this.renderNatively, [metadataTrack]);
        metadataTrack.mode = 'hidden';
        metadataTrack.inuse = true;
        this._cachedVTTCues[metadataTrack._id] = {};
    }
}

function clearTracks() {
    cancelXhr(this._itemTracks);
    const metadataTrack = this._tracksById && this._tracksById.nativemetadata;
    if (this.renderNatively || metadataTrack) {
        _removeCues(this.renderNatively, this.video.textTracks);
        if (metadataTrack) {
            metadataTrack.oncuechange = null;
        }
    }

    this._itemTracks = null;
    this._textTracks = null;
    this._tracksById = null;
    this._cuesByTrackId = null;
    this._metaCuesByTextTime = null;
    this._unknownCount = 0;
    this._currentTextTrackIndex = -1;
    this._activeCues = null;
    if (this.renderNatively) {
        // Removing listener first to ensure that removing cues does not trigger it unnecessarily
        this.removeTracksListener(this.video.textTracks, 'change', this.textTrackChangeHandler);
        _removeCues(this.renderNatively, this.video.textTracks);
    }
}

// Clear track cues to prevent duplicates
function clearCueData(trackId) {
    const cachedVTTCues = this._cachedVTTCues;
    if (cachedVTTCues && cachedVTTCues[trackId]) {
        cachedVTTCues[trackId] = {};
        if (this._tracksById) {
            this._tracksById[trackId].data = [];
        }
    }
}

function disableTextTrack() {
    if (this._textTracks) {
        const track = this._textTracks[this._currentTextTrackIndex];
        if (track) {
            // FF does not remove the active cue from the dom when the track is hidden, so we must disable it
            track.mode = 'disabled';
            const trackId = track._id;
            if (trackId && trackId.indexOf('nativecaptions') === 0) {
                track.mode = 'hidden';
            }
        }
    }
}

function enableTextTrack() {
    if (this._textTracks) {
        const track = this._textTracks[this._currentTextTrackIndex];
        if (track) {
            track.mode = 'showing';
        }
    }
}

function textTrackChangeHandler() {
    const textTracks = this.video.textTracks;
    const inUseTracks = filter(textTracks, function (track) {
        return (track.inuse || !track._id) && _kindSupported(track.kind);
    });
    if (!this._textTracks || _tracksModified.call(this, inUseTracks)) {
        this.setTextTracks(textTracks);
        return;
    }
    // If a caption/subtitle track is showing, find its index
    let selectedTextTrackIndex = -1;
    for (let i = 0; i < this._textTracks.length; i++) {
        if (this._textTracks[i].mode === 'showing') {
            selectedTextTrackIndex = i;
            break;
        }
    }

    // Notifying the model when the index changes keeps the current index in sync in iOS Fullscreen mode
    if (selectedTextTrackIndex !== this._currentTextTrackIndex) {
        this.setSubtitlesTrack(selectedTextTrackIndex + 1);
    }
}

// Used in MS Edge to get tracks from the videotag as they're added
function addTrackHandler() {
    this.setTextTracks(this.video.textTracks);
}

function addTextTracks(tracksArray) {
    if (!tracksArray) {
        return;
    }

    if (!this._textTracks) {
        this._initTextTracks();
    }

    tracksArray.forEach(itemTrack => {
        // only add valid and supported kinds https://developer.mozilla.org/en-US/docs/Web/HTML/Element/track
        if (itemTrack.kind && !_kindSupported(itemTrack.kind)) {
            return;
        }
        const textTrackAny = _createTrack.call(this, itemTrack);
        _addTrackToList.call(this, textTrackAny);
        if (itemTrack.file) {
            itemTrack.data = [];
            loadFile(itemTrack,
                (vttCues) => {
                    this.addVTTCuesToTrack(textTrackAny, vttCues);
                },
                error => {
                    this.trigger(WARNING, error);
                });
        }
    });

    if (this._textTracks && this._textTracks.length) {
        this.trigger('subtitlesTracks', { tracks: this._textTracks });
    }
}

function addVTTCuesToTrack(track, vttCues) {
    if (!this.renderNatively) {
        return;
    }

    const textTrack = this._tracksById[track._id];
    // the track may not be on the video tag yet
    if (!textTrack) {

        if (!this._cuesByTrackId) {
            this._cuesByTrackId = {};
        }
        this._cuesByTrackId[track._id] = { cues: vttCues, loaded: false };
        return;
    }
    // Cues already added
    if (this._cuesByTrackId[track._id] && this._cuesByTrackId[track._id].loaded) {
        return;
    }

    let cue;
    this._cuesByTrackId[track._id] = { cues: vttCues, loaded: true };

    while ((cue = vttCues.shift())) {
        _addCueToTrack(this.renderNatively, textTrack, cue);
    }
}

// ////////////////////
// //// PRIVATE METHODS
// ////////////////////

function _addCueToTrack(renderNatively, track, vttCue) {
    let cue = vttCue;
    if (Browser.ie && renderNatively) {
        // There's no support for the VTTCue interface in IE/Edge.
        // We need to convert VTTCue to TextTrackCue before adding them to the TextTrack
        // This unfortunately removes positioning properties from the cues
        cue = new window.TextTrackCue(vttCue.startTime, vttCue.endTime, vttCue.text);
    }

    // IE/Edge will throw an exception if cues are not inserted in time order: https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/13183203/
    if (Browser.ie) {
        insertCueInOrder(track, cue);
    } else {
        track.addCue(cue);
    }
}

function insertCueInOrder(track, vttCue) {
    const temp = [];
    // If the track mode is 'disabled', track.cues will be null; set it to hidden so that we can access.
    const mode = track.mode;
    track.mode = 'hidden';
    const cues = track.cues;
    for (let i = cues.length - 1; i >= 0; i--) {
        if (cues[i].startTime > vttCue.startTime) {
            temp.unshift(cues[i]);
            track.removeCue(cues[i]);
        } else {
            break;
        }
    }
    track.addCue(vttCue);
    temp.forEach(cue => track.addCue(cue));
    // Restore the original track state
    track.mode = mode;
}

function _removeCues(renderNatively, tracks) {
    if (tracks && tracks.length) {
        each(tracks, function(track) {
            // Let IE & Edge handle cleanup of non-sideloaded text tracks for native rendering
            if (Browser.ie && renderNatively && /^(native|subtitle|cc)/.test(track._id)) {
                return;
            }

            // Cues are inaccessible if the track is disabled. While hidden,
            // we can remove cues while the track is in a non-visible state
            // Set to disabled before hidden to ensure active cues disappear
            track.mode = 'disabled';
            track.mode = 'hidden';
            for (let i = track.cues.length; i--;) {
                track.removeCue(track.cues[i]);
            }
            if (!track.embedded) {
                track.mode = 'disabled';
            }
            track.inuse = false;
        });
    }
}

function _kindSupported(kind) {
    return kind === 'subtitles' || kind === 'captions';
}

function _initTextTracks() {
    this._textTracks = [];
    this._tracksById = {};
    this._metaCuesByTextTime = {};
    this._cuesByTrackId = {};
    this._cachedVTTCues = {};
    this._unknownCount = 0;
}

function _createTrack(itemTrack) {
    let track;
    const labelInfo = createLabel(itemTrack, this._unknownCount);
    const label = labelInfo.label;
    this._unknownCount = labelInfo.unknownCount;

    if (this.renderNatively || itemTrack.kind === 'metadata') {
        const tracks = this.video.textTracks;
        // TextTrack label is read only, so we'll need to create a new track if we don't
        // already have one with the same label
        track = findWhere(tracks, { label: label });

        if (!track) {
            track = this.video.addTextTrack(itemTrack.kind, label, itemTrack.language || '');
        }

        track.default = itemTrack.default;
        track.mode = 'disabled';
        track.inuse = true;
    } else {
        track = itemTrack;
        track.data = track.data || [];
    }

    if (!track._id) {
        track._id = createId(itemTrack, this._textTracks.length);
    }

    return track;
}

function _addTrackToList(track) {
    this._textTracks.push(track);
    this._tracksById[track._id] = track;
}

function _clearSideloadedTextTracks() {
    // Clear VTT textTracks
    if (!this._textTracks) {
        return;
    }
    const nonSideloadedTracks = this._textTracks.filter(function (track) {
        return track.embedded || track.groupid === 'subs';
    });
    this._initTextTracks();
    nonSideloadedTracks.forEach(function (track) {
        this._tracksById[track._id] = track;
    });
    this._textTracks = nonSideloadedTracks;
}

function _cueChangeHandler(e) {
    this.triggerActiveCues(e.currentTarget.activeCues);
}

function triggerActiveCues(activeCues) {
    if (!activeCues || !activeCues.length) {
        this._activeCues = null;
        return;
    }

    const previouslyActiveCues = this._activeCues || [];
    const dataCues = Array.prototype.filter.call(activeCues, cue => {
        // Prevent duplicate meta events for cues that were active in the previous "cuechange" event
        if (previouslyActiveCues.some(prevCue => cuesMatch(cue, prevCue))) {
            return false;
        }
        if (cue.data || cue.value) {
            return true;
        }
        if (cue.text) {
            const metadata = JSON.parse(cue.text);
            const metadataTime = cue.startTime;
            const event = {
                metadataTime,
                metadata
            };
            if (metadata.programDateTime) {
                event.programDateTime = metadata.programDateTime;
            }
            if (metadata.metadataType) {
                event.metadataType = metadata.metadataType;
                delete metadata.metadataType;
            }
            this.trigger(MEDIA_META, event);
        }
        return false;
    });

    if (dataCues.length) {
        const metadata = parseID3(dataCues);
        const metadataTime = dataCues[0].startTime;
        this.trigger(MEDIA_META, {
            metadataType: 'id3',
            metadataTime,
            metadata
        });
    }

    this._activeCues = Array.prototype.slice.call(activeCues);
}

function cuesMatch(cue1, cue2) {
    return cue1.startTime === cue2.startTime &&
        cue1.endTime === cue2.endTime &&
        cue1.text === cue2.text &&
        cue1.data === cue2.data &&
        cue1.value === cue2.value;
}

function _cacheVTTCue(track, vttCue, cacheKey) {
    const trackKind = track.kind;
    if (!this._cachedVTTCues[track._id]) {
        this._cachedVTTCues[track._id] = {};
    }
    const cachedCues = this._cachedVTTCues[track._id];
    let cacheKeyTime;

    switch (trackKind) {
        case 'captions':
        case 'subtitles': {
            // VTTCues should have unique start and end times, even in cases where there are multiple
            // active cues. This is safer than ensuring text is unique, which may be violated on seek.
            // Captions within .05s of each other are treated as unique to account for
            // quality switches where start/end times are slightly different.
            cacheKeyTime = cacheKey || Math.floor(vttCue.startTime * 20);
            const cacheLine = '_' + vttCue.line;
            const cacheValue = Math.floor(vttCue.endTime * 20);
            const cueExists = cachedCues[cacheKeyTime + cacheLine] || cachedCues[(cacheKeyTime + 1) + cacheLine] || cachedCues[(cacheKeyTime - 1) + cacheLine];

            if (cueExists && Math.abs(cueExists - cacheValue) <= 1) {
                return false;
            }

            cachedCues[cacheKeyTime + cacheLine] = cacheValue;
            return true;
        }
        case 'metadata': {
            const text = vttCue.data ? new Uint8Array(vttCue.data).join('') : vttCue.text;
            cacheKeyTime = cacheKey || vttCue.startTime + text;
            if (cachedCues[cacheKeyTime]) {
                return false;
            }

            cachedCues[cacheKeyTime] = vttCue.endTime;
            return true;
        }
        default:
            return false;
    }
}

function _tracksModified(inUseTracks) {
    // Need to add new textTracks coming from the video tag
    if (inUseTracks.length > this._textTracks.length) {
        return true;
    }

    // Tracks may have changed in Safari after an ad
    for (let i = 0; i < inUseTracks.length; i++) {
        const track = inUseTracks[i];
        if (!track._id || !this._tracksById[track._id]) {
            return true;
        }
    }

    return false;
}

export default Tracks;
