import { parseXML } from 'utils/parser';

const noop = function() {};

// TODO: deprecate (jwplayer-ads-vast uses utils.crossdomain(url)). It's used here for IE9 compatibility
export function crossdomain(uri) {
    const a = document.createElement('a');
    const b = document.createElement('a');
    a.href = location.href;
    try {
        b.href = uri;
        b.href = b.href; /* IE fix for relative urls */
        return a.protocol + '//' + a.host !== b.protocol + '//' + b.host;
    } catch (e) {/* swallow */}
    return true;
}

export function ajax(url, completeCallback, errorCallback, args) {
    if (url === Object(url)) {
        args = url;
        url = args.url;
    }
    let xhr;
    const options = Object.assign({
        xhr: null,
        url: url,
        withCredentials: false,
        retryWithoutCredentials: false,
        timeout: 60000,
        timeoutId: -1,
        oncomplete: completeCallback || noop,
        onerror: errorCallback || noop,
        mimeType: (args && !args.responseType) ? 'text/xml' : '',
        requireValidXML: false, /* Require responseXML */
        responseType: (args && args.plainText) ? 'text' : '', /* xhr.responseType ex: "json" or "text" */
        useDomParser: false,
        requestFilter: null
    }, args);
    const requestError = _requestError('Error loading file', options);

    if ('XMLHttpRequest' in window) {
        // Firefox, Chrome, Opera, Safari
        xhr = options.xhr = options.xhr || new window.XMLHttpRequest();
    } else {
        // browser cannot make xhr requests
        options.onerror('', url);
        return;
    }
    if (typeof options.requestFilter === 'function') {
        let result;
        try {
            result = options.requestFilter({
                url,
                xhr
            });
        } catch (e) {
            requestError(e);
            return xhr;
        }
        if (result && 'open' in result && 'send' in result) {
            xhr = options.xhr = result;
        }
    }
    xhr.onreadystatechange = _readyStateChangeHandler(options);

    xhr.onerror = requestError;

    if ('overrideMimeType' in xhr) {
        if (options.mimeType) {
            xhr.overrideMimeType(options.mimeType);
        }
    } else {
        options.useDomParser = true;
    }

    try {
        // remove anchors from the URL since they can't be loaded in IE
        url = url.replace(/#.*$/, '');
        xhr.open('GET', url, true);
    } catch (e) {
        requestError(e);
        return xhr;
    }

    if (options.responseType) {
        try {
            xhr.responseType = options.responseType;
        } catch (e) {/* ignore */}
    }

    if (options.timeout) {
        options.timeoutId = setTimeout(function() {
            abortAjax(xhr);
            options.onerror('Timeout', url, xhr);
        }, options.timeout);
        xhr.onabort = function() {
            clearTimeout(options.timeoutId);
        };
    }

    try {
        // xhr.withCredentials must must be set after xhr.open() is called
        // otherwise older WebKit browsers will throw INVALID_STATE_ERR
        if (options.withCredentials && 'withCredentials' in xhr) {
            xhr.withCredentials = true;
        }
        xhr.send();
    } catch (e) {
        requestError(e);
    }
    return xhr;
}

export function abortAjax(xhr) {
    xhr.onload = null;
    xhr.onprogress = null;
    xhr.onreadystatechange = null;
    xhr.onerror = null;
    if ('abort' in xhr) {
        xhr.abort();
    }
}

function _requestError(message, options) {
    return function(e) {
        const xhr = e.currentTarget || options.xhr;
        clearTimeout(options.timeoutId);
        // Handle Access-Control-Allow-Origin wildcard error when using withCredentials to send cookies
        if (options.retryWithoutCredentials && options.xhr.withCredentials) {
            abortAjax(xhr);
            const args = Object.assign({}, options, {
                xhr: null,
                withCredentials: false,
                retryWithoutCredentials: false
            });
            ajax(args);
            return;
        }
        options.onerror(message, options.url, xhr);
    };
}

function _readyStateChangeHandler(options) {
    return function(e) {
        const xhr = e.currentTarget || options.xhr;
        if (xhr.readyState === 4) {
            clearTimeout(options.timeoutId);
            if (xhr.status >= 400) {
                let message;
                if (xhr.status === 404) {
                    message = 'File not found';
                } else {
                    message = '' + xhr.status + '(' + xhr.statusText + ')';
                }
                return options.onerror(message, options.url, xhr);
            }
            if (xhr.status === 200) {
                return _ajaxComplete(options)(e);
            }
        }
    };
}

function _ajaxComplete(options) {
    return function(e) {
        const xhr = e.currentTarget || options.xhr;
        clearTimeout(options.timeoutId);
        if (options.responseType) {
            if (options.responseType === 'json') {
                return _jsonResponse(xhr, options);
            }
        } else {
            // Handle the case where an XML document was returned with an incorrect MIME type.
            let xml = xhr.responseXML;
            let firstChild;
            if (xml) {
                try {
                    // This will throw an error on Windows Mobile 7.5.
                    // We want to trigger the error so that we can move down to the next section
                    firstChild = xml.firstChild;
                } catch (error) {
                    /* ignore */
                }
            }
            if (xml && firstChild) {
                return _xmlResponse(xhr, xml, options);
            }
            if (options.useDomParser && xhr.responseText && !xml) {
                xml = parseXML(xhr.responseText);
                if (xml && xml.firstChild) {
                    return _xmlResponse(xhr, xml, options);
                }
            }
            if (options.requireValidXML) {
                options.onerror('Invalid XML', options.url, xhr);
                return;
            }
        }
        options.oncomplete(xhr);
    };
}

function _jsonResponse(xhr, options) {
    // insure that xhr.response is parsed JSON
    if (!xhr.response ||
        (typeof xhr.response === 'string' && xhr.responseText.substr(1) !== '"')) {
        try {
            xhr = Object.assign({}, xhr, {
                response: JSON.parse(xhr.responseText)
            });
        } catch (err) {
            options.onerror('Invalid JSON', options.url, xhr);
            return;
        }
    }
    return options.oncomplete(xhr);
}


function _xmlResponse(xhr, xml, options) {
    // Handle DOMParser 'parsererror'
    const doc = xml.documentElement;
    if (options.requireValidXML &&
            (doc.nodeName === 'parsererror' || doc.getElementsByTagName('parsererror').length)) {
        options.onerror('Invalid XML', options.url, xhr);
        return;
    }
    if (!xhr.responseXML) {
        xhr = Object.assign({}, xhr, {
            responseXML: xml
        });
    }
    return options.oncomplete(xhr);
}
