// Runs the search-query matching off the main thread, so typing in the
// search box stays smooth even with thousands of notes. Deliberately kept
// free of DOM APIs (Workers don't have them) — the main thread precomputes
// each note's plain-text haystack (via the existing preview cache) and only
// hands over plain data: {id, title, folder, tags, haystack, updatedAt,
// locked, archived, pinned}.

const SEARCH_OP_ALIASES = { folder: "dossier" };

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function parseSearchQuery(raw) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens
    .map((tok) => {
      let text = tok;
      let negate = false;
      if (text.startsWith("-") && text.length > 1) {
        negate = true;
        text = text.slice(1);
      }
      const opMatch = /^(tag|dossier|folder|avant|apres|après|est|prop):(.+)$/i.exec(text);
      if (opMatch) {
        let op = stripDiacritics(opMatch[1].toLowerCase());
        op = SEARCH_OP_ALIASES[op] || op;
        return { negate, op, value: opMatch[2].toLowerCase() };
      }
      return { negate, text: text.toLowerCase() };
    })
    .filter((c) => c.op || c.text);
}

function clauseMatches(item, clause) {
  if (clause.op === "tag") return (item.tags || []).some((t) => t.toLowerCase() === clause.value);
  if (clause.op === "dossier") return (item.folder || "").toLowerCase().startsWith(clause.value);
  if (clause.op === "avant" || clause.op === "apres") {
    const d = Date.parse(clause.value);
    if (Number.isNaN(d)) return false;
    return clause.op === "avant" ? item.updatedAt < d : item.updatedAt > d;
  }
  if (clause.op === "est") {
    const v = stripDiacritics(clause.value);
    if (v.startsWith("verrouill")) return !!item.locked;
    if (v.startsWith("archiv")) return !!item.archived;
    if (v.startsWith("epingl")) return !!item.pinned;
    return false;
  }
  if (clause.op === "prop") {
    const sep = clause.value.indexOf(":");
    const propKey = (sep === -1 ? clause.value : clause.value.slice(0, sep)).trim();
    const propValue = sep === -1 ? null : clause.value.slice(sep + 1).trim();
    const props = item.properties || {};
    const actualKey = Object.keys(props).find((k) => k.toLowerCase() === propKey);
    if (!actualKey) return false;
    return propValue === null || props[actualKey].toLowerCase() === propValue;
  }
  return item.haystack.includes(clause.text);
}

function noteMatchesQuery(item, clauses) {
  return clauses.every((c) => (c.negate ? !clauseMatches(item, c) : clauseMatches(item, c)));
}

self.onmessage = (e) => {
  const { requestId, items, query } = e.data;
  const clauses = query ? parseSearchQuery(query) : [];
  const matchedIds = clauses.length ? items.filter((item) => noteMatchesQuery(item, clauses)).map((item) => item.id) : items.map((item) => item.id);
  self.postMessage({ requestId, matchedIds });
};
