/**
 * lib/edit.mjs — edits a source string by ranges (replace, remove, insert) and applies them all at once.
 * Part of vanilla-build. MIT License.
 *
 * Ranges refer to the original string, so edits can be recorded in any order. Inserts at the same position keep
 * the order they were recorded in and come before a replacement starting there. Overlapping replacements throw.
 */
export class Editor {
  constructor(src) {
    this.src = src;
    this.edits = [];
    this.seq = 0;
  }
  overwrite(start, end, text) {
    if (start > end || start < 0 || end > this.src.length) throw new RangeError('Editor: bad range ' + start + '..' + end);
    this.edits.push({ start, end, text: String(text), seq: this.seq++ });
    return this;
  }
  remove(start, end) { return start === end ? this : this.overwrite(start, end, ''); }
  insert(pos, text) { return this.overwrite(pos, pos, text); }
  get changed() { return this.edits.length > 0; }

  toString() {
    const list = this.edits.slice().sort((a, b) => a.start - b.start || (a.end - a.start === 0 ? 0 : 1) - (b.end - b.start === 0 ? 0 : 1) || a.seq - b.seq);
    let out = '';
    let pos = 0;
    for (const e of list) {
      if (e.start < pos) {
        if (e.start === e.end && e.start === pos) { out += e.text; continue; }
        throw new Error('Editor: overlapping edits at ' + e.start + ' (previous edit ends at ' + pos + ')');
      }
      out += this.src.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    return out + this.src.slice(pos);
  }
}
