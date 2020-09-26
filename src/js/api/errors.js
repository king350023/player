import { isValidNumber } from 'utils/underscore';
/**
 * @type {ErrorCode} Base code for a setup failure.
 **/
export const SETUP_ERROR_UNKNOWN = 100000;

/**
 * @type {ErrorCode} Setup failed because it took longer than 30 seconds.
 */
export const SETUP_ERROR_TIMEOUT = 100001;

/**
 * @enum {ErrorCode} Setup failed because no license key was found.
 */
export const SETUP_ERROR_LICENSE_MISSING = 100011;

/**
 * @enum {ErrorCode} Setup failed because the license key was invalid.
 */
export const SETUP_ERROR_LICENSE_INVALID = 100012;

/**
 * @enum {ErrorCode} Setup failed because the license key expired.
 */
export const SETUP_ERROR_LICENSE_EXPIRED = 100013;

/**
 * @enum {ErrorCode} Setup failed because a core module failed to load.
 */
export const SETUP_ERROR_LOADING_CORE_JS = 101000;

/**
 * @enum {ErrorCode} Setup failed because the playlist failed to load.
 */
export const SETUP_ERROR_LOADING_PLAYLIST = 102000;

/**
 * @enum {ErrorCode} Playback stopped because the playlist failed to load.
 */
export const ERROR_LOADING_PLAYLIST = 202000;

/**
 * @enum {ErrorCode} Setup failed because the initial provider failed to load.
 */
export const SETUP_ERROR_LOADING_PROVIDER = 104000;

/**
 * @enum {ErrorCode} An error occurred when switching playlist items.
 */
export const ERROR_LOADING_PLAYLIST_ITEM = 203000;

/**
 * @enum {ErrorCode} The current playlist item has no source media.
 */
export const ERROR_PLAYLIST_ITEM_MISSING_SOURCE = 203640;

/**
 * @enum {ErrorCode} Between playlist items, the required provider could not be loaded.
 */
export const ERROR_LOADING_PROVIDER = 204000;

/**
 * @enum {ErrorCode} An error occurred duing Flash setup.
 */
export const FLASH_SETUP_ERROR = 210001;

/**
 * @enum {ErrorCode} An error occurred during Flash playback.
 */
export const FLASH_ERROR = 210000;

/**
 * @enum {ErrorCode} A media error occurred during Flash playback.
 */
export const FLASH_MEDIA_ERROR = 214000;

/**
 * @enum {ErrorKey}
 */
export const MSG_CANT_PLAY_VIDEO = 'cantPlayVideo';

/**
 * @enum {ErrorKey}
 */
export const MSG_BAD_CONNECTION = 'badConnection';

/**
 * @enum {ErrorKey}
 */
export const MSG_CANT_LOAD_PLAYER = 'cantLoadPlayer';

/**
 * @enum {ErrorKey}
 */
export const MSG_CANT_PLAY_IN_BROWSER = 'cantPlayInBrowser';

/**
 * @enum {ErrorKey}
 */
export const MSG_LIVE_STREAM_DOWN = 'liveStreamDown';

/**
 * @enum {ErrorKey}
 */
export const MSG_PROTECTED_CONTENT = 'protectedContent';

/**
 * @enum {ErrorKey}
 */
export const MSG_TECHNICAL_ERROR = 'technicalError';

/**
 * Class used to create "setupError" and "error" event instances.
 * @class PlayerError
 * @param {message} string - The error message.
 * @param {code} [ErrorCode] - The error code.
 * @param {sourceError} [Error] - The lower level error, caught by the player, which resulted in this error.
 */
export class PlayerError {
    constructor(key, code, sourceError = null) {
        this.code = isValidNumber(code) ? code : 0;
        this.key = key;
        this.sourceError = sourceError;
    }

    static logMessage(code) {
        const suffix = code % 1000;
        const prefix = Math.floor((code - suffix) / 1000);
        let codeStr = code;

        if (suffix >= 400 && suffix < 600) {
            codeStr = `${prefix}400-${prefix}599`;
        }
        return `JW Player Error ${code}. For more information see https://developer.jwplayer.com/jw-player/docs/developer-guide/api/errors-reference#${codeStr}`;
    }
}

export function convertToPlayerError(key, code, error) {
    if (!(error instanceof PlayerError) || !error.code) {
        // Transform any unhandled error into a PlayerError so emitted events adhere to a uniform structure
        return new PlayerError(key, code, error);
    }
    return error;
}

export function composePlayerError(error, superCode) {
    const playerError = convertToPlayerError(MSG_TECHNICAL_ERROR, superCode, error);
    playerError.code = (error.code || 0) + superCode;
    return playerError;
}
