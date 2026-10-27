'use strict';

/**
 * Robust RFC-4180 CSV Parser.
 * Correctly parses quotes, escaped quotes (""), embedded commas, CRLF, and UTF-8 BOM.
 */
function parseCsv(text) {
  let str = String(text || '');
  // Strip UTF-8 BOM if present
  if (str.charCodeAt(0) === 0xFEFF) {
    str = str.slice(1);
  }

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < str.length && str[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (i + 1 < str.length && str[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField.trim());
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Normalizes a header label for flexible matching.
 */
function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Splits part numbers string into array of clean part number strings.
 */
function splitPartNumbers(val) {
  if (Array.isArray(val)) {
    return val.map(v => String(v).trim()).filter(Boolean);
  }
  const str = String(val || '').trim();
  if (!str) return [];
  // Split on commas, semicolons, slashes, or word "or"
  return str
    .split(/[,;\/]|\bor\b/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Imports parts from CSV or JSON text.
 *
 * @param {string} format 'csv' | 'json'
 * @param {string|Object} content
 * @param {string} mode 'append' | 'replace'
 * @param {Array} existingParts
 * @returns {Object} { parts, addedCount, skippedCount, errors: [] }
 */
function importParts(format, content, mode = 'append', existingParts = []) {
  const errors = [];
  const parsedItems = [];

  if (format === 'json') {
    let json;
    try {
      json = typeof content === 'object' ? content : JSON.parse(content);
    } catch (err) {
      return { ok: false, error: 'Invalid JSON format: ' + err.message };
    }

    const items = Array.isArray(json) ? json : (Array.isArray(json.parts) ? json.parts : []);
    items.forEach((item, idx) => {
      const name = String(item.name || item.part || item.description || '').trim();
      if (!name) {
        errors.push(`Row ${idx + 1}: Missing part name`);
        return;
      }
      const rawPn = item.partNumbers || item.partNumber || item.pn || item.oem || [];
      const partNumbers = splitPartNumbers(rawPn);
      const rawPrice = item.shopPrice !== undefined ? item.shopPrice : (item.price !== undefined ? item.price : item.oemPrice);
      const shopPrice = Math.max(0, parseFloat(rawPrice) || 0);
      const shopTaxable = item.shopTaxable !== false && item.taxable !== false;
      const notes = String(item.notes || '').trim();

      parsedItems.push({
        name,
        partNumbers,
        shopPrice,
        shopTaxable,
        notes
      });
    });
  } else if (format === 'csv') {
    const rows = parseCsv(content);
    if (rows.length === 0) {
      return { ok: false, error: 'CSV file is empty' };
    }

    // Detect header row
    const headerRow = rows[0];
    let nameIdx = -1;
    let pnIdx = -1;
    let priceIdx = -1;
    let taxableIdx = -1;
    let notesIdx = -1;

    headerRow.forEach((col, idx) => {
      const norm = normalizeHeader(col);
      if (['name', 'partname', 'part', 'description', 'item'].includes(norm)) nameIdx = idx;
      else if (['partnumber', 'partnumbers', 'pn', 'partno', 'oem', 'oempartnumber', 'gmpartnumber', 'gmpartnumbers'].includes(norm)) pnIdx = idx;
      else if (['shopprice', 'price', 'oemprice', 'quote', 'cost'].includes(norm)) priceIdx = idx;
      else if (['taxable', 'shoptaxable', 'tax'].includes(norm)) taxableIdx = idx;
      else if (['notes', 'note', 'details'].includes(norm)) notesIdx = idx;
    });

    // If no header matches, assume defaults by column order: 0: name, 1: pn, 2: price, 3: notes
    const hasHeader = nameIdx !== -1 || pnIdx !== -1 || priceIdx !== -1;
    const startIndex = hasHeader ? 1 : 0;
    if (!hasHeader) {
      nameIdx = 0;
      pnIdx = 1;
      priceIdx = 2;
      notesIdx = 3;
    }

    for (let r = startIndex; r < rows.length; r++) {
      const row = rows[r];
      if (row.length === 0 || (row.length === 1 && !row[0])) continue;

      const name = nameIdx !== -1 && row[nameIdx] ? row[nameIdx].trim() : '';
      if (!name) {
        errors.push(`Row ${r + 1}: Missing part name`);
        continue;
      }

      const rawPn = pnIdx !== -1 && row[pnIdx] ? row[pnIdx] : '';
      const partNumbers = splitPartNumbers(rawPn);

      let shopPrice = 0;
      if (priceIdx !== -1 && row[priceIdx]) {
        const cleanedPrice = row[priceIdx].replace(/[$,]/g, '').trim();
        shopPrice = Math.max(0, parseFloat(cleanedPrice) || 0);
      }

      let shopTaxable = true;
      if (taxableIdx !== -1 && row[taxableIdx]) {
        const tVal = row[taxableIdx].toLowerCase().trim();
        if (['no', 'false', '0', 'n'].includes(tVal)) shopTaxable = false;
      }

      const notes = notesIdx !== -1 && row[notesIdx] ? row[notesIdx].trim() : '';

      parsedItems.push({
        name,
        partNumbers,
        shopPrice,
        shopTaxable,
        notes
      });
    }
  } else {
    return { ok: false, error: 'Unsupported format: ' + format };
  }

  // Generate IDs and merge/replace
  let finalParts = mode === 'replace' ? [] : [...existingParts];
  let addedCount = 0;

  parsedItems.forEach((item, idx) => {
    const id = 'part-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '-' + idx;
    finalParts.push({
      id,
      name: item.name,
      partNumbers: item.partNumbers,
      shopPrice: item.shopPrice,
      shopTaxable: item.shopTaxable,
      notes: item.notes
    });
    addedCount++;
  });

  return {
    ok: true,
    parts: finalParts,
    addedCount,
    skippedCount: errors.length,
    errors
  };
}

module.exports = {
  parseCsv,
  splitPartNumbers,
  importParts
};
