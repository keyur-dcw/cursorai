/**
 * n8n Code Node: Epicor → Shopify mapping (product/pricing/inventory/image/collection)
 *
 * - Supports mappingType: direct | script | static
 * - Tracks matchedFields/customFields and unmatchedFields (missing epicorField, disabled by flag, invalid script, etc.)
 * - Feature flags:
 *   - manageProductStatus
 *   - manageProductPublishing
 *   - enableImageMapping
 *   - enableCollectionMapping
 *   - enablePricingMapping
 *   - enableInventoryMapping
 *
 * NOTE: This script expects incoming `items` to include:
 * - Mapping group records: { entityId: "1".."5", mappingJson: [...] }
 * - Epicor payload record(s): { payload: { PartNum: "...", ... } }
 * - Optional config record: { manageProductStatus, manageProductPublishing, enableImageMapping, enableCollectionMapping, enablePricingMapping, enableInventoryMapping }
 * - Optional auth/shop record: { shop, accessToken, sessionId, jobId, entityId }
 */
// ====================================================
// 1. COLLECT INPUTS
// ====================================================
const rawMappingGroups = [];
const epicorPayloads = [];
let shop = null;
let accessToken = null;
let sessionId = null;
let jobId = null;
let entityId = null;

// Feature flags (defaults)
let manageProductStatus = false;
let manageProductPublishing = false;
let enableImageMapping = false;
let enableCollectionMapping = false;
let enablePricingMapping = false;
let enableInventoryMapping = false;

for (const item of items) {
  if (Array.isArray(item?.json?.mappingJson)) {
    rawMappingGroups.push(item.json);
  }

  if (item?.json?.payload && item.json.payload.PartNum) {
    epicorPayloads.push(item.json.payload);
  }

  if (item?.json?.shop) shop = item.json.shop;
  if (item?.json?.accessToken) accessToken = item.json.accessToken;
  if (item?.json?.sessionId && !sessionId) sessionId = item.json.sessionId;
  if (item?.json?.jobId && !jobId) jobId = item.json.jobId;
  if (item?.json?.entityId && !entityId) entityId = item.json.entityId;

  // Config flags record
  if (item?.json?.manageProductStatus !== undefined) {
    manageProductStatus = item.json.manageProductStatus === true;
    manageProductPublishing = item.json.manageProductPublishing === true;
    enableImageMapping = item.json.enableImageMapping === true;
    enableCollectionMapping = item.json.enableCollectionMapping === true;
    enablePricingMapping = item.json.enablePricingMapping === true;
    enableInventoryMapping = item.json.enableInventoryMapping === true;
  }
}

if (!epicorPayloads.length) {
  throw new Error('No Epicor payload items found');
}

// ====================================================
// 2. DEDUPE MAPPING GROUPS (by entityId)
// ====================================================
const mappingGroups = [];
const seenEntityIds = new Set();
for (const group of rawMappingGroups) {
  const eid = String(group?.entityId ?? '');
  if (!eid) continue;
  if (!seenEntityIds.has(eid)) {
    seenEntityIds.add(eid);
    mappingGroups.push({ ...group, entityId: eid });
  }
}

// ====================================================
// 3. HELPERS
// ====================================================
const toNumber = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const capitalizeEachWord = (s) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s);

const isNil = (v) => v === null || v === undefined;

function pushUnmatched(target, map, reason, details = {}) {
  if (!target || !Array.isArray(target.unmatchedFields)) return;
  target.unmatchedFields.push({
    id: map?.id ?? null,
    epicorField: map?.epicorField ?? null,
    shopifyField: map?.shopifyField ?? null,
    mappingType: map?.mappingType ?? null,
    reason,
    ...details,
  });
}

// ====================================================
// 4. SCRIPT VALIDATION + APPLY
// ====================================================
function normalizeNullToken(s) {
  if (typeof s !== 'string') return s;
  return s.trim().toUpperCase() === 'NULL' ? null : s;
}

function parsePipeListStrict(s) {
  if (typeof s !== 'string') {
    return { ok: false, error: 'Value must be a string' };
  }

  if (s.length === 0) {
    return { ok: false, error: 'Empty value is not allowed' };
  }

  // Not valid:
  // - Space before pipe — "ENABLE |"
  // - Space after pipe  — "ENABLE| DISABLE"
  if (s.includes(' |') || s.includes('| ')) {
    return { ok: false, error: 'Spaces around pipe are not allowed' };
  }

  // - Leading pipe — "|Enable"
  // - Trailing pipe — "Enable|"
  if (s.startsWith('|') || s.endsWith('|')) {
    return { ok: false, error: 'Leading/trailing pipe is not allowed' };
  }

  // - Consecutive pipes — "Enable||Disable"
  if (s.includes('||')) {
    return { ok: false, error: 'Consecutive pipes are not allowed' };
  }

  const parts = s.split('|');

  // - Empty segments — "Enable| |Disable" (also catches "Enable||Disable")
  for (const part of parts) {
    if (part.length === 0) {
      return { ok: false, error: 'Empty segment is not allowed' };
    }
    if (part.trim() !== part) {
      return { ok: false, error: 'Leading/trailing spaces in segments are not allowed' };
    }
    if (part.trim().length === 0) {
      return { ok: false, error: 'Empty/whitespace segment is not allowed' };
    }
  }

  return { ok: true, parts, isMulti: parts.length > 1 };
}

function validateReplaceScript(script) {
  const fromCandidate = script?.fromMulti ?? script?.from;
  const toCandidate = script?.toMulti ?? script?.to;

  if (isNil(fromCandidate) || isNil(toCandidate)) {
    return { ok: false, error: 'Replace script requires both from and to' };
  }

  const fromParsed = parsePipeListStrict(String(fromCandidate));
  if (!fromParsed.ok) return { ok: false, error: `Invalid "from": ${fromParsed.error}` };

  const toParsed = parsePipeListStrict(String(toCandidate));
  if (!toParsed.ok) return { ok: false, error: `Invalid "to": ${toParsed.error}` };

  const fromCount = fromParsed.parts.length;
  const toCount = toParsed.parts.length;

  // Not valid:
  // - From multiple, To single — "Enable|Disable" → "TRUE"
  if (fromCount > 1 && toCount === 1) {
    return { ok: false, error: 'From multiple to single is not allowed' };
  }

  // - From single, To multiple — "Enable" → "TRUE|FALSE"
  if (fromCount === 1 && toCount > 1) {
    return { ok: false, error: 'From single to multiple is not allowed' };
  }

  // - Both multiple, count mismatch — "Enable|Disable" → "TRUE|FALSE|NULL"
  if (fromCount > 1 && toCount > 1 && fromCount !== toCount) {
    return { ok: false, error: 'From/To multiple counts must match' };
  }

  return {
    ok: true,
    fromParts: fromParsed.parts,
    toParts: toParsed.parts,
    isMulti: fromCount > 1,
  };
}

function applyScript(value, script, entityIdForOp) {
  if (value == null) return { ok: true, value: null };
  const str = String(value);

  const op = script?.operation?.toLowerCase?.() ?? '';

  switch (op) {
    case 'uppercase':
      return { ok: true, value: str.toUpperCase() };
    case 'lowercase':
      return { ok: true, value: str.toLowerCase() };
    case 'capitalize':
      return { ok: true, value: capitalize(str) };
    case 'capitalizeeachword':
    case 'capitalize each word':
      return { ok: true, value: capitalizeEachWord(str) };
    case 'integer':
      return { ok: true, value: toNumber(str) };
    case 'round': {
      const n = Number(str);
      return { ok: true, value: Number.isNaN(n) ? null : Math.round(n) };
    }
    case 'length': {
      // preserve prior behavior: entityId '5' => don't truncate
      if (String(entityIdForOp) === '5') return { ok: true, value: str };
      const max = Number(script?.text);
      return { ok: true, value: Number.isNaN(max) ? str : str.substring(0, max) };
    }
    case 'prepend':
      return { ok: true, value: `${script?.text ?? ''}${str}` };
    case 'append':
      return { ok: true, value: `${str}${script?.text ?? ''}` };
    case 'replace': {
      const validated = validateReplaceScript(script);
      if (!validated.ok) return { ok: false, error: validated.error };

      const fromParts = validated.fromParts;
      const toParts = validated.toParts;

      // Single ↔ Single (valid): treat as value mapping (supports "NULL" → null)
      if (!validated.isMulti) {
        if (str === fromParts[0]) {
          return { ok: true, value: normalizeNullToken(toParts[0]) };
        }
        return { ok: true, value: str };
      }

      // Multi ↔ Multi (valid): value mapping with matched index (supports "NULL" → null)
      const idx = fromParts.indexOf(str);
      if (idx === -1) {
        return { ok: true, value: str };
      }
      return { ok: true, value: normalizeNullToken(toParts[idx]) };
    }
    default:
      return { ok: true, value: str };
  }
}

// ====================================================
// IMAGE HELPERS (ROBUST TYPE DETECTION)
// ====================================================
function extFromMagic(base64) {
  if (!base64) return '';
  if (base64.startsWith('/9j/')) return 'jpg';
  if (base64.startsWith('iVBORw0KGgo')) return 'png';
  if (base64.startsWith('R0lGOD')) return 'gif';
  if (base64.startsWith('UklGR')) return 'webp';
  return '';
}

function extFromFileType(ft) {
  if (!ft) return '';
  const clean = String(ft).toLowerCase().replace('.', '');
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(clean)) {
    return clean === 'jpeg' ? 'jpg' : clean;
  }
  return '';
}

function mimeFromExt(ext) {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function toBinary(base64, fileName, mimeType) {
  if (!base64 || !fileName || !mimeType) return null;
  const buffer = Buffer.from(base64, 'base64');
  return {
    data: buffer.toString('base64'),
    fileName,
    mimeType,
  };
}

// ====================================================
// 5. PROCESS EACH EPICOR ITEM
// ====================================================
const results = [];

for (const epicorData of epicorPayloads) {
  const resolveEpicorField = (field) => {
    if (!field) return { exists: false, value: null };
    if (Object.prototype.hasOwnProperty.call(epicorData, field)) {
      return { exists: true, value: epicorData[field] };
    }
    return { exists: false, value: null };
  };

  const finalOutput = {
    shop,
    accessToken,
    sessionId,
    jobId,
    entityId,
    product: { matchedFields: {}, customFields: {}, unmatchedFields: [] },
    pricing: { matchedFields: {}, unmatchedFields: [] },
    inventory: { matchedFields: {}, unmatchedFields: [] },
    image: { matchedFields: {}, unmatchedFields: [] },
    collection: { matchedFields: { collectionIds: [] }, unmatchedFields: [] },
  };

  const binary = {};

  // ====================================================
  // 6. APPLY MAPPINGS (gated by entity + feature flags)
  // ====================================================
  for (const group of mappingGroups) {
    const gid = String(group.entityId);
    let target = null;

    if (gid === '1') target = finalOutput.product;
    if (gid === '2' && enablePricingMapping) target = finalOutput.pricing;
    if (gid === '3' && enableInventoryMapping) target = finalOutput.inventory;
    if (gid === '4' && enableImageMapping) target = finalOutput.image;
    if (gid === '5' && enableCollectionMapping) target = finalOutput.collection;

    if (!target) {
      // group disabled by feature flag
      continue;
    }

    for (const map of group.mappingJson || []) {
      if (!map?.isActive) continue;

      const epicorField = map.epicorField;
      const shopifyField = map.shopifyField;
      const mappingType = String(map.mappingType || '').toLowerCase();
      const script = map.script;
      const isShopifyMetaField = map.isShopifyMetaField === true;

      // product status/publishing gating
      if (gid === '1' && shopifyField === 'status' && manageProductStatus !== true) {
        pushUnmatched(target, map, 'disabled_by_flag', { flag: 'manageProductStatus' });
        continue;
      }
      if (gid === '1' && shopifyField === 'published' && manageProductPublishing !== true) {
        pushUnmatched(target, map, 'disabled_by_flag', { flag: 'manageProductPublishing' });
        continue;
      }

      let value = null;

      if (mappingType === 'static') {
        value = map.staticValue ?? null;
      } else if (mappingType === 'direct') {
        const resolved = resolveEpicorField(epicorField);
        if (!resolved.exists) {
          pushUnmatched(target, map, 'epicor_field_missing');
          continue;
        }
        value = resolved.value;
      } else if (mappingType === 'script') {
        const resolved = resolveEpicorField(epicorField);
        if (!resolved.exists) {
          pushUnmatched(target, map, 'epicor_field_missing');
          continue;
        }
        const applied = applyScript(resolved.value, script, gid);
        if (!applied.ok) {
          pushUnmatched(target, map, 'script_validation_failed', { error: applied.error });
          continue;
        }
        value = applied.value;
      } else {
        pushUnmatched(target, map, 'unsupported_mapping_type');
        continue;
      }

      // collection behavior: treat shopifyField as collection GID to attach
      if (gid === '5') {
        if (typeof shopifyField === 'string' && shopifyField.startsWith('gid://shopify/Collection/')) {
          // If mapping is direct/script and the resolved value is falsy, skip adding.
          // For static mappings, any non-null/empty value enables the add.
          const shouldAdd =
            mappingType === 'static'
              ? value !== null && String(value).length > 0
              : Boolean(value);
          if (shouldAdd) {
            finalOutput.collection.matchedFields.collectionIds.push(shopifyField);
          } else {
            pushUnmatched(target, map, 'collection_condition_not_met');
          }
        } else {
          pushUnmatched(target, map, 'invalid_collection_gid');
        }
        continue;
      }

      // meta fields only apply to product in this output shape
      if (gid === '1' && isShopifyMetaField) {
        finalOutput.product.customFields[shopifyField] = value;
      } else {
        target.matchedFields[shopifyField] = value;
      }
    }
  }

  // ====================================================
  // 7. IMAGE BASE64 → BINARY + EXTENSION FIX
  // ====================================================
  if (enableImageMapping && epicorData?.image?.ImageContent) {
    const img = epicorData.image;

    const ext = extFromFileType(img.FileType) || extFromMagic(img.ImageContent) || 'jpg';
    const mime = mimeFromExt(ext);
    const baseName = img.ImageFileName || img.ImageID || epicorData.PartNum;
    const fileName = `${baseName}.${ext}`;

    // ensure originalSource has extension
    finalOutput.image.matchedFields.originalSource = fileName;

    const imageBinary = toBinary(img.ImageContent, fileName, mime);
    if (imageBinary) {
      binary.image = imageBinary;
    }
  }

  results.push({ json: finalOutput, binary });
}

// ====================================================
// 8. RETURN
// ====================================================
return results;

