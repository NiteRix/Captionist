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
            scriptVersion: '0.1.2'
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
            frameWidth: 1920,
            frameHeight: 1080,
            warnings: []
        };

        try { info.sequenceID = String(seq.sequenceID); } catch (e) {}
        try { info.videoTrackCount = seq.videoTracks.numTracks; } catch (e1) {}
        try {
            var st = seq.getSettings();
            info.frameWidth = Number(st.videoFrameWidth) || 1920;
            info.frameHeight = Number(st.videoFrameHeight) || 1080;
        } catch (eF) {
            info.frameWidth = 1920;
            info.frameHeight = 1080;
        }
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
                    // (projectItem, startAtTime in seconds, [captionFormat]).
                    // The format is optional and defaults to Subtitle; passing
                    // a boolean here, as this once did, is not a format.
                    seq.createCaptionTrack(item, 0);
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

    /* ------------------------------------------------- animated graphics */

    function secToTime(sec) {
        var t = new Time();
        try { t.ticks = String(Math.round(sec * TICKS_PER_SECOND)); }
        catch (e) { t.seconds = sec; }
        return t;
    }

    function secToTicks(sec) { return String(Math.round(sec * TICKS_PER_SECOND)); }

    function clipCount(track) {
        try { return track.clips.numItems; } catch (e) { return 0; }
    }

    /** The clip whose start matches `sec`, within half a frame. */
    function clipStartingAt(track, sec, tolerance) {
        var n = clipCount(track), i;
        for (i = 0; i < n; i++) {
            try {
                if (Math.abs(timeToSec(track.clips[i].start) - sec) <= (tolerance || 0.02)) {
                    return track.clips[i];
                }
            } catch (e) {}
        }
        return null;
    }

    /*
     * Track.overwriteClip's `time` is documented as a ticks string, but
     * Adobe's own example in the same reference passes seconds. Rather than
     * pick one, place the clip and check where it actually landed; the winning
     * form is remembered for the rest of the run.
     *
     * Getting this wrong is not subtle: seconds interpreted as ticks puts
     * every caption at 00:00:00, each overwriting the last.
     */
    var overwriteForm = null;

    function placeClip(track, projectItem, startSec) {
        var forms = overwriteForm ? [overwriteForm] : ['ticks', 'seconds'];
        var i, value, clip;

        for (i = 0; i < forms.length; i++) {
            value = (forms[i] === 'ticks') ? secToTicks(startSec) : startSec;
            try { track.overwriteClip(projectItem, value); }
            catch (e) { continue; }

            clip = clipStartingAt(track, startSec);
            if (clip) {
                if (!overwriteForm) { note('overwriteClip accepts the "' + forms[i] + '" time form.'); }
                overwriteForm = forms[i];
                return clip;
            }
        }
        return null;
    }

    /** Finds a component on a track item by any of several names. */
    function componentNamed(clip, names) {
        var n = 0;
        try { n = clip.components.numItems; } catch (e) { return null; }
        for (var i = 0; i < n; i++) {
            try {
                var comp = clip.components[i];
                var name = String(comp.displayName);
                for (var j = 0; j < names.length; j++) {
                    if (name === names[j]) { return comp; }
                }
            } catch (e1) {}
        }
        return null;
    }

    function propertyNamed(component, names) {
        if (!component) { return null; }
        var n = 0;
        try { n = component.properties.numItems; } catch (e) { return null; }
        for (var i = 0; i < n; i++) {
            try {
                var prop = component.properties[i];
                var name = String(prop.displayName);
                for (var j = 0; j < names.length; j++) {
                    if (name === names[j]) { return prop; }
                }
            } catch (e1) {}
        }
        return null;
    }

    /*
     * Motion and Opacity are localised, so matching on the English name alone
     * would quietly do nothing on a non-English Premiere. Falling back to
     * position within the component list is crude but beats silence.
     */
    function motionComponent(clip) {
        var c = componentNamed(clip, ['Motion', 'Bewegung', 'Mouvement', 'Movimiento', 'Movimento']);
        if (c) { return c; }
        try { return clip.components[1]; } catch (e) { return null; }
    }

    function opacityComponent(clip) {
        var c = componentNamed(clip, ['Opacity', 'Deckkraft', 'Opacit\u00e9', 'Opacidad', 'Opacit\u00e0']);
        if (c) { return c; }
        try { return clip.components[2]; } catch (e) { return null; }
    }

    function propertyFor(clip, which) {
        if (which === 'opacity') {
            return propertyNamed(opacityComponent(clip),
                ['Opacity', 'Deckkraft', 'Opacit\u00e9', 'Opacidad', 'Opacit\u00e0']);
        }
        var motion = motionComponent(clip);
        if (which === 'scale') {
            return propertyNamed(motion, ['Scale', 'Skalierung', '\u00c9chelle', 'Escala', 'Scala']);
        }
        return propertyNamed(motion, ['Position', 'Posizione']);
    }

    var REST = { scale: 100, opacity: 100, position: [0.5, 0.5] };

    /**
     * Puts a property back to rest and takes its keyframes off.
     *
     * This is the safety net for everything below: a caption that is placed
     * but not animated is a caption you can see. A caption left mid-animation
     * is one you cannot, because every preset begins and ends at zero opacity.
     */
    function clearKeys(clip, which) {
        try {
            var prop = propertyFor(clip, which);
            if (!prop) { return; }
            try { prop.setTimeVarying(false); } catch (e1) {}
            try { prop.setValue(REST[which], 1); } catch (e2) {}
        } catch (e) {}
    }

    /**
     * Writes one property's keyframes, `offset` seconds along.
     *
     * updateUI is documented as an Integer, not a Boolean, and addKey is
     * documented to throw on non-colour properties - so setValueAtKey does the
     * work and addKey is only a best-effort nudge.
     */
    function writeKeys(clip, which, keys, offset) {
        var prop = propertyFor(clip, which);
        if (!prop) { return 'no ' + which + ' property'; }

        try {
            if (typeof prop.areKeyframesSupported === 'function' && !prop.areKeyframesSupported()) {
                return which + ' does not support keyframes';
            }
        } catch (e) {}

        // Start from a known visible state, so a half-written animation cannot
        // leave the caption transparent.
        try { prop.setTimeVarying(false); } catch (e0) {}
        try { prop.setValue(REST[which], 1); } catch (e0b) {}

        try { prop.setTimeVarying(true); }
        catch (e1) { return which + ' is not keyframable: ' + e1; }

        var wrote = 0;
        for (var i = 0; i < keys.length; i++) {
            var t = secToTime(offset + keys[i].time);
            try { prop.addKey(t); } catch (e2) {}
            try { prop.setValueAtKey(t, keys[i].value, 1); wrote++; }
            catch (e3) { return which + ' key at ' + keys[i].time.toFixed(2) + 's failed: ' + e3; }
        }
        if (!wrote) { return which + ' accepted no keyframes'; }
        return null;
    }

    /** How many of the requested keyframes Premiere actually kept, and where. */
    function keysLanded(clip, which, keys, offset) {
        var got = null;
        try { got = propertyFor(clip, which).getKeys(); } catch (e) { return 0; }
        if (!got || !got.length) { return 0; }

        var hits = 0, i, j;
        for (i = 0; i < keys.length; i++) {
            var want = offset + keys[i].time;
            for (j = 0; j < got.length; j++) {
                if (Math.abs(timeToSec(got[j]) - want) <= 0.02) { hits++; break; }
            }
        }
        return hits;
    }

    /*
     * Which clock a keyframe time is on.
     *
     * The scripting reference says only "when the keyframe should be added" -
     * it never says whether that is measured from the start of the sequence or
     * from the start of the clip. The answer decides whether a caption is
     * visible at all, because every animation preset begins and ends at zero
     * opacity: keys written on the wrong clock all fall outside the clip, the
     * clip holds the nearest keyframe's value, and that value is zero. A
     * caption that is on the timeline, selects fine and shows nothing looks
     * exactly like this.
     *
     * So the first caption is a probe. Its keys are written at the sequence
     * offset and read back; if Premiere kept them there, that is the clock it
     * is on. A clip-relative implementation cannot keep a key thirty seconds
     * into a two second still, so failing that check means the other clock.
     * If neither survives, nothing is animated - see clearKeys above.
     */
    var keyOffsetMode = null;      // 'sequence' | 'clip'

    function offsetFor(clip, mode) {
        if (mode === 'clip') {
            // Media time, which is where a trimmed clip's keyframes start.
            try { return timeToSec(clip.inPoint); } catch (e) { return 0; }
        }
        try { return timeToSec(clip.start); } catch (e2) { return 0; }
    }

    /**
     * Animates one clip. Returns null on success, or why not.
     * On the first clip it also settles which clock to use for the rest.
     */
    function animateClip(clip, keys) {
        var modes = keyOffsetMode ? [keyOffsetMode] : ['sequence', 'clip'];
        var which, m, problem;

        for (m = 0; m < modes.length; m++) {
            var offset = offsetFor(clip, modes[m]);
            var wrote = 0, want = 0, firstProblem = null;

            for (which in keys) {
                if (!keys.hasOwnProperty(which)) { continue; }
                problem = writeKeys(clip, which, keys[which], offset);
                if (problem) { if (!firstProblem) { firstProblem = problem; } continue; }
                want += keys[which].length;
                wrote += keysLanded(clip, which, keys[which], offset);
            }

            // Every key back where it was put means this is the right clock.
            if (want && wrote >= want) {
                if (!keyOffsetMode) {
                    keyOffsetMode = modes[m];
                    note('Keyframes are on the ' + modes[m] + ' clock (' + wrote +
                         '/' + want + ' kept at offset ' + offset.toFixed(2) + 's).');
                }
                return null;
            }

            for (which in keys) {
                if (keys.hasOwnProperty(which)) { clearKeys(clip, which); }
            }
            if (m === modes.length - 1) {
                return firstProblem ||
                    ('Premiere kept ' + wrote + ' of ' + want + ' keyframes; left static');
            }
        }
        return 'no keyframes could be written';
    }

    /** Reports back what Premiere actually stored, for the first animated clip. */
    function describeKeys(clip, which) {
        try {
            var prop = propertyFor(clip, which);
            if (!prop || typeof prop.getKeys !== 'function') { return ''; }
            var got = prop.getKeys();
            if (!got || !got.length) { return which + ': no keyframes stored'; }
            var times = [];
            for (var i = 0; i < got.length && i < 6; i++) { times.push(timeToSec(got[i]).toFixed(3)); }
            return which + ': ' + got.length + ' keyframes at ' + times.join(', ') + 's';
        } catch (e) { return ''; }
    }

    /**
     * Places rendered caption graphics on a video track and animates them.
     *
     * opts = {
     *   items: [{ file, start, end, keys }],
     *   trackIndex, binName, animate
     * }
     *
     * Placement and animation are reported separately: captions that land but
     * do not animate are still a usable result, and saying so is more helpful
     * than failing the whole run.
     */
    function insertGraphics(optsJson) {
        var opts;
        try { opts = JSON.parse(optsJson); }
        catch (e) { return fail('Could not read the options sent by the panel: ' + e); }

        var items = opts.items || [];
        if (!items.length) { return fail('There are no caption graphics to place.'); }

        var seq = activeSequence();
        if (!seq) { return fail('No sequence is open.'); }

        var trackCount = 0;
        try { trackCount = seq.videoTracks.numTracks; } catch (e1) {}
        if (trackCount < 1) { return fail('This sequence has no video track to put captions on.'); }

        /*
         * Captions go on the highest EMPTY video track.
         *
         * Two things go wrong with simply taking the highest track. If it
         * already holds footage, overwriteClip does what it says and destroys
         * it. And if the only free track is below the picture, the captions
         * are placed perfectly and covered up by the video on top of them -
         * which looks, from the timeline, exactly like nothing happened.
         */
        var trackIndex = -1, t;
        if (opts.trackIndex !== undefined && opts.trackIndex !== null &&
            Number(opts.trackIndex) >= 0 && Number(opts.trackIndex) < trackCount) {
            trackIndex = Number(opts.trackIndex);
        } else {
            for (t = trackCount - 1; t >= 0; t--) {
                if (clipCount(seq.videoTracks[t]) === 0) { trackIndex = t; break; }
            }
            // Every track is in use, so ask Premiere for another one. Adding
            // tracks is not in the documented API, so this goes through QE and
            // is checked rather than trusted.
            if (trackIndex < 0) {
                var before = trackCount;
                try {
                    app.enableQE();
                    qe.project.getActiveSequence().addTracks(1, before, 0, 0);
                } catch (eQE) {}
                try { trackCount = seq.videoTracks.numTracks; } catch (eQE2) {}
                if (trackCount > before && clipCount(seq.videoTracks[trackCount - 1]) === 0) {
                    trackIndex = trackCount - 1;
                    note('Added video track V' + trackCount + ' for the captions.');
                }
            }
            if (trackIndex < 0) {
                return fail('Every video track already has clips on it, and Premiere would ' +
                            'not add another. Add an empty video track above your footage ' +
                            'and try again.');
            }
        }

        var track = seq.videoTracks[trackIndex];
        try {
            if (typeof track.isLocked === 'function' && track.isLocked()) {
                return fail('Video track V' + (trackIndex + 1) + ' is locked. Unlock it and try again.');
            }
        } catch (e2) {}

        /*
         * A video track with its output switched off renders nothing, and the
         * clips on it still select normally - so the captions would be there
         * and invisible. Switch it back on rather than leave that puzzle.
         */
        try {
            if (typeof track.isMuted === 'function' && track.isMuted()) {
                track.setMute(0);
                note('Video track V' + (trackIndex + 1) + ' had its output switched off. Switched it on.');
            }
        } catch (e2b) {}

        note('Captions go on V' + (trackIndex + 1) + ' of ' + trackCount + '.');

        /*
         * Import straight into the destination bin. Passing null here, as this
         * once did, leaves it to Premiere where the items land - and the
         * lookup below then cannot find them.
         */
        var bin = findOrCreateBin(opts.binName || 'Captions');
        var paths = [], i;
        for (i = 0; i < items.length; i++) { paths.push(items[i].file); }
        try { app.project.importFiles(paths, true, bin, false); }
        catch (e3) { return fail('Premiere would not import the caption graphics: ' + e3); }

        /* map file name -> project item, searching the whole tree */
        var byName = {};
        function index(item, depth) {
            if (depth > 6) { return; }
            var n = 0;
            try { n = item.children.numItems; } catch (e) { return; }
            for (var c = 0; c < n; c++) {
                var child;
                try { child = item.children[c]; } catch (e1) { continue; }
                try {
                    if (child.type === ProjectItemType.BIN) { index(child, depth + 1); }
                    else if (!byName[String(child.name)]) { byName[String(child.name)] = child; }
                } catch (e2) {}
            }
        }
        index(bin || app.project.rootItem, 0);
        if (bin) { index(app.project.rootItem, 0); }

        var placed = 0, animated = 0, failures = [];
        var firstAnimError = '';
        var keyReport = '';

        for (i = 0; i < items.length; i++) {
            var it = items[i];
            var leaf = String(it.file).replace(/^.*[\\\/]/, '');
            var pi = byName[leaf];
            if (!pi) { failures.push(leaf + ': not found after import'); continue; }

            /*
             * setInPoint/setOutPoint take TICKS, not a Time object - the
             * parameter is named `seconds` but documented as ticks. Setting
             * these is what gives the still the caption's duration instead of
             * Premiere's default still length.
             */
            try {
                pi.setInPoint(secToTicks(0), 4);
                pi.setOutPoint(secToTicks(it.end - it.start), 4);
            } catch (e7) {
                try {
                    pi.setInPoint(0, 4);
                    pi.setOutPoint(it.end - it.start, 4);
                } catch (e8) {}
            }

            var clip = placeClip(track, pi, it.start);
            if (!clip) {
                failures.push(leaf + ': Premiere would not place it at ' + it.start.toFixed(2) + 's');
                // If the very first one will not land, stop rather than pile
                // every caption on top of itself at the head of the timeline.
                if (placed === 0 && i >= 2) {
                    return fail('Premiere placed no captions where they were asked to go. ' +
                                'Nothing further was attempted, to avoid filling the timeline ' +
                                'with misplaced graphics.', { failures: failures });
                }
                continue;
            }
            placed++;

            try { clip.end = secToTime(it.end); } catch (e9) {}

            if (opts.animate !== false && it.keys) {
                var err = animateClip(clip, it.keys);
                if (!err) {
                    animated++;
                    // Report what Premiere stored for the first animated clip,
                    // so a silent no-op is visible in the panel's log.
                    if (!keyReport) {
                        for (var w2 in it.keys) {
                            if (!it.keys.hasOwnProperty(w2)) { continue; }
                            var d = describeKeys(clip, w2);
                            if (d) { keyReport += (keyReport ? '; ' : '') + d; }
                        }
                        if (keyReport) {
                            note('First animated caption sits at ' + it.start.toFixed(2) +
                                 's on the timeline; stored ' + keyReport);
                        }
                    }
                } else if (!firstAnimError) {
                    firstAnimError = err;
                }
            }
        }

        if (!placed) {
            return fail('None of the caption graphics could be placed. ' +
                        (failures.length ? failures[0] : ''), { failures: failures });
        }

        var warnings = [];
        if (failures.length) {
            warnings.push(failures.length + ' caption(s) could not be placed.');
            for (i = 0; i < failures.length && i < 5; i++) { note(failures[i]); }
        }
        if (opts.animate !== false && animated < placed) {
            warnings.push((placed - animated) + ' caption(s) were placed but not animated' +
                          (firstAnimError ? ' (' + firstAnimError + ')' : '') + '.');
        }

        return reply({
            ok: true,
            placed: placed,
            animated: animated,
            track: trackIndex + 1,
            keyClock: keyOffsetMode || '',
            warnings: warnings
        });
    }

    return {
        ping: ping,
        getSequenceInfo: getSequenceInfo,
        importSubtitles: importSubtitles,
        insertGraphics: insertGraphics
    };

}());
