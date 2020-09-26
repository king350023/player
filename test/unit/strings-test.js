import {
    pad,
    extension,
    seconds,
    offsetToSeconds,
    hms,
    prefix,
    suffix
} from 'utils/strings';

describe('strings', function() {

    it('pad', function() {
        let str = pad('test', 7, '1');
        expect(str, 'strings padding correctly done').to.equal('111test');

        str = pad('test', 3, '1');
        expect(str, 'strings padding with smaller length than str should not pad anything').to.equal('test');
    });

    it('extension', function() {
        let ext = extension('invalid');
        expect(ext, 'invalid path extension returns undefined').to.equal(undefined);

        ext = extension(null);
        expect(ext, 'null path extension').to.equal('');

        ext = extension('Manifest(format=m3u8-aapl-v3)"');
        expect(ext, 'Azure file extension master').to.equal('m3u8');

        ext = extension('/Manifest(video,format=m3u8-aapl-v3,audiotrack=audio)');
        expect(ext, 'Azure file extension playlist').to.equal('m3u8');

        ext = extension('hello.jpg');
        expect(ext, 'extension correctly received').to.equal('jpg');

        // akamai url's
        ext = extension('https://akamaihd.net/i/2013/01/20131114_56c3456df2b9b_vg01/,480_270_500,.mp4.csmil/master.m3u8?hdnea=st=145747587700~exp=645456~acl=/*~hmac=34523452345sdfggdfssd345345');
        expect(ext, 'Akamai Tokenized Url\'s').to.equal('m3u8');

        ext = extension('https://domain.net/master.m3u8?dot=.');
        expect(ext, 'Dot in the search param').to.equal('m3u8');

        ext = extension('https://domain.net/master.file.m3u8?dot=.#id.1');
        expect(ext, 'Dot in the search and hash portions of the url').to.equal('m3u8');
    });

    it('seconds', function() {
        timeConversionTest(seconds);
    });

    it('offsetToSeconds', function () {
        timeConversionTest(offsetToSeconds);

        let sec = offsetToSeconds('50%', 100);
        expect(sec, 'percentage and duration inputs return seconds').to.equal(50);

        sec = offsetToSeconds('25%');
        expect(sec, 'percentage without duration returns null').to.equal(null);

        sec = offsetToSeconds('25%', 0);
        expect(sec, 'percentage with duration of 0 returns null').to.equal(null);

        sec = offsetToSeconds('25%', 'abc');
        expect(sec, 'percentage with NaN duration returns null').to.equal(null);

        sec = offsetToSeconds('50', 100);
        expect(sec, 'non-percentage numeric string with duration inputs return seconds').to.equal(50);

        sec = offsetToSeconds(null, 100);
        expect(sec, 'null and duration inputs return 0').to.equal(0);

        sec = offsetToSeconds(undefined, 100);
        expect(sec, 'undefined and duration inputs return 0').to.equal(0);

        sec = offsetToSeconds('', 100);
        expect(sec, 'empty string and duration inputs return 0').to.equal(0);

        sec = offsetToSeconds('abc', 100);
        expect(sec, 'alpha only strings and duration inputs return 0').to.equal(0);
    });

    function timeConversionTest(converter) {
        let sec = converter(5);
        expect(sec, 'number input returns input').to.equal(5);

        sec = converter('5s');
        expect(sec, 'seconds input returns seconds').to.equal(5);

        sec = converter('5m');
        expect(sec, 'minutes input returns seconds').to.equal(300);

        sec = converter('1h');
        expect(sec, 'hours input returns seconds').to.equal(3600);

        sec = converter('5');
        expect(sec, 'string number input returns number').to.equal(5);

        sec = converter('1:01');
        expect(sec, 'minute seconds input returns seconds').to.equal(61);

        sec = converter('01:01:01.111');
        expect(sec, 'hours minute seconds milliseconds input returns seconds').to.equal(3661.111);

        sec = converter('00:00:01:15');
        expect(sec, 'hours minute seconds frames input without frameRate returns seconds without frames').to.equal(1);

        if (converter === offsetToSeconds) {
            sec = converter('00:01:01:25', null, 50);
        } else {
            sec = converter('00:01:01:25', 50);
        }
        expect(sec, 'hours minute seconds frames input with frameRate returns seconds').to.equal(61.5);
    }

    it('hms', function() {
        let str = hms(3661);
        expect(str, 'hms gives correct time string format').to.equal('01:01:01.000');

        str = hms(1.11111);
        expect(str, 'hms gives milliseconds rounded to 3dp').to.equal('00:00:01.111');
    });

    it('prefix, suffix', function() {
        const pre = prefix(['1', '2'], '0');
        expect(pre[0], 'prefix with 0 index correct').to.equal('01');
        expect(pre[1], 'prefix with 1 index correct').to.equal('02');

        const suf = suffix(['1', '2'], '0');
        expect(suf[0], 'prefix suffix 0 index correct').to.equal('10');
        expect(suf[1], 'prefix suffix 1 index correct').to.equal('20');
    });
});
