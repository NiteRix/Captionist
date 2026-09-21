/*
 * VENDORED from NiteRix/Silencer @ 7df6387 -- extension/jsx/json2.jsx
 * Keep in step with upstream; scripts/sync-common.sh reports drift.
 */
/*
 * Minimal JSON implementation for ExtendScript (ES3), which ships without one.
 * Only stringify/parse are needed, and every value crossing this bridge is
 * produced by Silencer itself, so parse can lean on eval.
 */
if (typeof JSON === 'undefined') { JSON = {}; }

(function () {
    function quote(str) {
        var out = '"', i, c, cc, hex;
        for (i = 0; i < str.length; i++) {
            c = str.charAt(i);
            cc = str.charCodeAt(i);
            if (c === '"') { out += '\\"'; }
            else if (c === '\\') { out += '\\\\'; }
            else if (c === '\n') { out += '\\n'; }
            else if (c === '\r') { out += '\\r'; }
            else if (c === '\t') { out += '\\t'; }
            else if (c === '\b') { out += '\\b'; }
            else if (c === '\f') { out += '\\f'; }
            else if (cc < 0x20 || cc > 0x7e) {
                // Escape everything non-ASCII so the CEP bridge cannot mangle it.
                hex = cc.toString(16);
                while (hex.length < 4) { hex = '0' + hex; }
                out += '\\u' + hex;
            } else { out += c; }
        }
        return out + '"';
    }

    function ser(value) {
        var i, k, parts, v;
        if (value === null || value === undefined) { return 'null'; }
        switch (typeof value) {
        case 'number':
            return isFinite(value) ? String(value) : 'null';
        case 'boolean':
            return value ? 'true' : 'false';
        case 'string':
            return quote(value);
        case 'object':
            if (value instanceof Array) {
                parts = [];
                for (i = 0; i < value.length; i++) { parts.push(ser(value[i])); }
                return '[' + parts.join(',') + ']';
            }
            parts = [];
            for (k in value) {
                if (value.hasOwnProperty(k)) {
                    v = ser(value[k]);
                    if (v !== undefined) { parts.push(quote(String(k)) + ':' + v); }
                }
            }
            return '{' + parts.join(',') + '}';
        }
        return 'null';
    }

    if (typeof JSON.stringify !== 'function') { JSON.stringify = function (v) { return ser(v); }; }
    if (typeof JSON.parse !== 'function') { JSON.parse = function (s) { return eval('(' + s + ')'); }; }
}());
