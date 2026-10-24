// lib/jito-age.js: how old a Jito tip snapshot may be before /api/jito-tips refuses it.
// bin/jito-tips-collect.js writes one every 15 minutes (R20; it was every 5). A run that cannot reach 40 tips writes nothing, so the file simply ages: three
// missed runs (45 minutes) are tolerated and the answer carries age_s and as_of; beyond that the route is a 503, not charged. JITO_MAX_AGE_S overrides.
'use strict';
const REFRESH_S = 15 * 60;
const MAX_AGE_S = () => { const n = Number(process.env.JITO_MAX_AGE_S); return Number.isFinite(n) && n > 0 ? n : 3 * REFRESH_S; };
module.exports = { REFRESH_S, MAX_AGE_S };
