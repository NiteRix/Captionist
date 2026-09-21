/*
 * Captionist - automatic subtitles for Adobe Premiere Pro.
 * Host-side (ExtendScript) half.
 *
 * Reads the sequence so the panel knows what audio to transcribe, and puts the
 * finished subtitles back. Everything public returns a JSON string, because
 * that is all CSInterface.evalScript can carry.
 */

// @include "common/json2.jsx"

$.captionist = (function () {

    var TICKS_PER_SECOND = 254016000000;

    var log = [];
    function note(msg) { log.push(String(msg)); }

    function reply(obj) {
        obj.log = log;
        var s;
        try { s = JSON.stringify(obj); }
        catch (e) { s = '{"ok":false,"error":"Could not serialise result: ' + e + '"}'; }
        log = [];
        return s;
    }

    function fail(msg, extra) {
        var o = extra || {};
        o.ok = false;
        o.error = String(msg);
        return reply(o);
    }

    /* ---------------------------------------------------------------- time */

    function timeToSec(t) {
        if (t === undefined || t === null) { return 0; }
        try {
            if (t.ticks !== undefined && t.ticks !== null) {
                var n = Number(t.ticks);
                if (!isNaN(n)) { return n / TICKS_PER_SECOND; }
            }
        } catch (e) {}
        try {
            var s = parseFloat(t.seconds);
            if (!isNaN(s)) { return s; }
        } catch (e2) {}
        var direct = Number(t);
        return isNaN(direct) ? 0 : direct / TICKS_PER_SECOND;
    }

    function safeCall(obj, name) {
        try { if (obj && typeof obj[name] === 'function') { return obj[name](); } } catch (e) {}
        return null;
    }

    function activeSequence() {
        try { return app.project.activeSequence; } catch (e) { return null; }
    }

    function sequenceFps(seq) {
        try {
            var tb = Number(seq.timebase);
            if (tb > 0) { return TICKS_PER_SECOND / tb; }
        } catch (e) {}
        return 30;
    }

    /* ---------------------------------------------------------------- ping */

    function ping() {
        var seq = activeSequence();
        return reply({
            ok: true,
            app: String(app.version),
            hasSequence: !!seq,
            sequenceName: seq ? String(seq.name) : '',
            scriptVersion: '0.1.0'
        });
    }

    /* -------------------------------------------------------- sequence info */

    function describeClip(clip, trackIndex, clipIndex) {
        var rec = {
            track: trackIndex,
            index: clipIndex,
            name: '',
            start: timeToSec(clip.start),
            end: timeToSec(clip.end),
            inPoint: timeToSec(clip.inPoint),
            outPoint: timeToSec(clip.outPoint),
            speed: 1,
            disabled: false,
            mediaPath: ''
        };
        try { rec.name = String(clip.name); } catch (e) {}
        try { rec.disabled = (clip.disabled === true); } catch (e1) {}

        var sp = safeCall(clip, 'getSpeed');
        var spn = Number(sp);
        if (!isNaN(spn) && spn > 0) { rec.speed = spn; }

        try {
            var pi = clip.projectItem;
            if (pi) {
                var p = pi.getMediaPath();
                rec.mediaPath = p ? String(p) : '';
            }
        } catch (e2) {}
        return rec;
    }

    function getSequenceInfo() {
        var seq = activeSequence();
        if (!seq) {
            return fail('No sequence is open. Open a sequence in Premiere and try again.');
        }

        var info = {
            ok: true,
            name: String(seq.name),
            sequenceID: '',
            fps: sequenceFps(seq),
            duration: 0,
            audioTracks: [],
            videoTrackCount: 0,
            warnings: []
        };

        try { info.sequenceID = String(seq.sequenceID); } catch (e) {}
        try { info.videoTrackCount = seq.videoTracks.numTracks; } catch (e1) {}
        try {
            var endRaw = seq.end;
            var endSec = (endRaw && endRaw.ticks !== undefined)
                ? timeToSec(endRaw) : Number(endRaw) / TICKS_PER_SECOND;
            if (!isNaN(endSec) && endSec > 0) { info.duration = endSec; }
        } catch (e2) {}

        var n = 0;
        try { n = seq.audioTracks.numTracks; } catch (e3) { n = 0; }
        var total = 0, withMedia = 0, t, c;

        for (t = 0; t < n; t++) {
            var track = seq.audioTracks[t];
            var rec = { index: t, name: '', muted: false, clips: [] };
            try { rec.name = String(track.name); } catch (e4) {}
            try { rec.muted = (safeCall(track, 'isMuted') === true); } catch (e5) {}

            var cn = 0;
            try { cn = track.clips.numItems; } catch (e6) { cn = 0; }
            for (c = 0; c < cn; c++) {
                try {
                    var clip = track.clips[c];
                    if (!clip) { continue; }
                    var d = describeClip(clip, t, c);
                    rec.clips.push(d);
                    total++;
                    if (d.mediaPath) { withMedia++; }
                } catch (e7) {
                    note('Skipped audio clip ' + t + '/' + c + ': ' + e7);
                }
            }
            info.audioTracks.push(rec);
        }

        if (total === 0) {
            info.warnings.push('This sequence has no audio clips, so there is nothing to transcribe.');
        } else if (withMedia === 0) {
            info.warnings.push('None of the audio clips resolve to a file on disk (merged clips, ' +
                               'nested sequences or offline media).');
        } else if (withMedia < total) {
            info.warnings.push((total - withMedia) + ' of ' + total +
                               ' audio clips have no file on disk and were skipped.');
        }

        if (!info.duration || info.duration <= 0) {
            var maxEnd = 0, i, j;
            for (i = 0; i < info.audioTracks.length; i++) {
                for (j = 0; j < info.audioTracks[i].clips.length; j++) {
                    if (info.audioTracks[i].clips[j].end > maxEnd) {
                        maxEnd = info.audioTracks[i].clips[j].end;
                    }
                }
            }
            info.duration = maxEnd;
        }

        return reply(info);
    }

    /* ------------------------------------------------------- bringing it in */

    function findOrCreateBin(name) {
        var root = app.project.rootItem, i, child;
        for (i = 0; i < root.children.numItems; i++) {
            child = root.children[i];
            try {
                if (child.type === ProjectItemType.BIN && String(child.name) === name) { return child; }
            } catch (e) {}
        }
        try { return root.createBin(name); }
        catch (e2) { note('Could not create bin "' + name + '": ' + e2); return null; }
    }

    function projectItemCount() {
        try { return app.project.rootItem.children.numItems; } catch (e) { return -1; }
    }

    /**
     * Brings the subtitle file into the project, and attaches it as a caption
     * track when Premiere allows it.
     *
     * Importing always works; the caption track does not exist on every
     * version, so its absence is reported rather than treated as a failure -
     * the file is on disk either way and can be dragged in by hand.
     */
    function importSubtitles(optsJson) {
        var opts;
        try { opts = JSON.parse(optsJson); }
        catch (e) { return fail('Could not read the options sent by the panel: ' + e); }

        if (!opts.path) { return fail('No subtitle file was given.'); }

        var seq = activeSequence();
        if (!seq) { return fail('No sequence is open.'); }

        var before = projectItemCount();
        var imported = false;
        try { imported = app.project.importFiles([opts.path], true, null, false); }
        catch (e1) { return fail('Premiere would not import the subtitle file: ' + e1); }

        if (!imported && projectItemCount() === before) {
            return fail('Premiere reported that it could not import the subtitle file.');
        }

        /* find what just arrived */
        var item = null;
        try {
            var root = app.project.rootItem;
            var wanted = String(opts.path).replace(/^.*[\\\/]/, '');
            for (var i = root.children.numItems - 1; i >= 0; i--) {
                var child = root.children[i];
                try {
                    if (String(child.name) === wanted) { item = child; break; }
                } catch (e2) {}
            }
        } catch (e3) {}

        if (item && opts.binName) {
            var bin = findOrCreateBin(opts.binName);
            if (bin) {
                try { item.moveBin(bin); } catch (e4) { note('Could not move into the bin: ' + e4); }
            }
        }

        var attached = false;
        var attachError = '';
        if (item && opts.attach !== false) {
            try {
                if (typeof seq.createCaptionTrack === 'function') {
                    seq.createCaptionTrack(item, 0, true);
                    attached = true;
                } else {
                    attachError = 'This version of Premiere has no scriptable caption track.';
                }
            } catch (e5) {
                attachError = String(e5);
            }
        }

        if (!attached && attachError) { note('Caption track not created: ' + attachError); }

        return reply({
            ok: true,
            imported: true,
            attached: attached,
            attachError: attachError,
            bin: opts.binName || ''
        });
    }

    return {
        ping: ping,
        getSequenceInfo: getSequenceInfo,
        importSubtitles: importSubtitles
    };

}());
