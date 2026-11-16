/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContactItem {
  raw: string;
  phone: string;
  name: string;
  jid: string;
}

/**
 * Sanitizes and normalizes phone numbers.
 * Rules:
 * 1. Strips all non-digit characters except leading '+'.
 * 2. If a 10-digit number starts with 6, 7, 8, or 9 (standard Indian mobile prefixes),
 *    automatically prepends country code 91.
 * 3. Strips leading 0 if followed by a 10-digit Indian number.
 * 4. Ensures length is valid (between 10 and 15 digits according to ITU E.164).
 */
export function sanitizePhoneNumber(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  // Trim whitespace
  let cleaned = input.trim();

  // Remove common prefix markers like tel:, whatsapp:
  cleaned = cleaned.replace(/^(tel:|whatsapp:)/i, '');

  // Remove all non-digits except an optional leading plus
  const hasPlus = cleaned.startsWith('+');
  cleaned = cleaned.replace(/\D/g, '');

  if (!cleaned) return null;

  // If number starts with 0 and followed by 10 digits starting with 6-9 (Indian standard trunk prefix 0)
  if (cleaned.length === 11 && cleaned.startsWith('0') && /^[6-9]/.test(cleaned.slice(1))) {
    cleaned = '91' + cleaned.slice(1);
  }

  // 10-digit Indian mobile number missing country code
  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    cleaned = '91' + cleaned;
  }

  // If input had +91 or other international prefix, cleaned is now pure digits
  // Check valid E.164 range (minimum 10 digits e.g. local+country code, maximum 15 digits)
  if (cleaned.length < 10 || cleaned.length > 15) {
    return null;
  }

  return cleaned;
}

/**
 * Parses raw contacts input (multi-line text, space-separated, comma-separated, or CSV style)
 * Supports:
 * - Space-separated numbers: "9876543210 9876543211 9876543212" (tens to hundreds of numbers)
 * - Quoted space-separated: '"9876543210" "9876543211" "9876543212"'
 * - 9876543210
 * - 9876543210, John Doe
 * - John Doe, 9876543210
 * - 9876543210 John Doe
 * - +91 98765 43210
 * - CSV with headers like Phone, Name
 * Deduplicates by sanitized phone number and caps at maxContacts (default 800).
 */
export function parseContacts(rawText: string, maxContacts = 800): {
  contacts: ContactItem[];
  duplicatesCount: number;
  invalidCount: number;
  invalidLines: string[];
} {
  if (!rawText || !rawText.trim()) {
    return {
      contacts: [],
      duplicatesCount: 0,
      invalidCount: 0,
      invalidLines: [],
    };
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const seenPhones = new Set<string>();
  const contacts: ContactItem[] = [];
  const invalidLines: string[] = [];
  let duplicatesCount = 0;

  const tryAddContact = (
    phoneCandidate: string,
    nameCandidate: string,
    rawCandidate: string
  ): boolean => {
    if (contacts.length >= maxContacts) {
      return false;
    }

    const sanitized = sanitizePhoneNumber(phoneCandidate);
    if (!sanitized) {
      invalidLines.push(rawCandidate);
      return true;
    }

    if (seenPhones.has(sanitized)) {
      duplicatesCount++;
      return true;
    }

    seenPhones.add(sanitized);
    contacts.push({
      raw: rawCandidate,
      phone: sanitized,
      name: nameCandidate.trim() || 'Member',
      jid: `${sanitized}@s.whatsapp.net`,
    });

    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    if (contacts.length >= maxContacts) break;
    const line = lines[i];

    // Skip potential CSV header line
    if (i === 0 && /(phone|mobile|number|contact)/i.test(line) && /(name|fullname|user)/i.test(line)) {
      continue;
    }

    // Check if line contains comma or tab or semicolon
    if (/[,;\t]/.test(line)) {
      const parts = line.split(/[,;\t]/).map(p => p.trim()).filter(Boolean);

      // If 2 parts: determine if it is a phone + name pair or 2 phone numbers
      if (parts.length === 2) {
        const s0 = sanitizePhoneNumber(parts[0]);
        const s1 = sanitizePhoneNumber(parts[1]);

        if (s0 !== null && s1 !== null) {
          // Both are valid phone numbers (e.g., "9876543210, 9876543211")
          tryAddContact(parts[0], '', parts[0]);
          tryAddContact(parts[1], '', parts[1]);
          continue;
        } else if (s0 !== null && s1 === null) {
          // Phone, Name (e.g., "9876543210, John Doe")
          tryAddContact(parts[0], parts[1], line);
          continue;
        } else if (s1 !== null && s0 === null) {
          // Name, Phone (e.g., "John Doe, 9876543210")
          tryAddContact(parts[1], parts[0], line);
          continue;
        }
      } else if (parts.length > 2) {
        // Multiple comma/semicolon parts: check if multiple are valid phone numbers
        const validPhoneCount = parts.filter(p => sanitizePhoneNumber(p) !== null).length;
        if (validPhoneCount >= 2) {
          for (const p of parts) {
            if (contacts.length >= maxContacts) break;
            tryAddContact(p, '', p);
          }
          continue;
        } else if (sanitizePhoneNumber(parts[0]) !== null) {
          // First part is phone, rest is name
          tryAddContact(parts[0], parts.slice(1).join(' '), line);
          continue;
        }
      }
    }

    // Extract space-separated or quote-delimited tokens from the line
    // Matches "..." or '...' or consecutive non-whitespace characters
    const tokenRegex = /"([^"]+)"|'([^']+)'|(\S+)/g;
    const tokens: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(line)) !== null) {
      const tok = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (tok) tokens.push(tok);
    }

    if (tokens.length === 0) continue;

    if (tokens.length === 1) {
      tryAddContact(tokens[0], '', tokens[0]);
      continue;
    }

    // If there are multiple tokens on this line:
    // Check how many individual tokens are valid phone numbers
    const validPhoneIndices: number[] = [];
    for (let j = 0; j < tokens.length; j++) {
      const cleanTok = tokens[j].replace(/^[,;]+|[,;]+$/g, '').trim();
      if (sanitizePhoneNumber(cleanTok) !== null) {
        validPhoneIndices.push(j);
      }
    }

    if (validPhoneIndices.length >= 2) {
      // Multiple phone numbers separated by spaces (e.g. "9876543210 9876543211 9876543212" or '"9876543210" "9876543211"')
      for (const tok of tokens) {
        if (contacts.length >= maxContacts) break;
        const cleanTok = tok.replace(/^[,;]+|[,;]+$/g, '').trim();
        tryAddContact(cleanTok, '', tok);
      }
    } else if (validPhoneIndices.length === 1) {
      // Exactly one phone number and other tokens forming a name
      const phoneIdx = validPhoneIndices[0];
      const phoneTok = tokens[phoneIdx].replace(/^[,;]+|[,;]+$/g, '').trim();
      const nameParts = tokens.filter((_, idx) => idx !== phoneIdx);
      tryAddContact(phoneTok, nameParts.join(' '), line);
    } else {
      // 0 individual tokens were valid phone numbers.
      // Check if the entire line itself is a single formatted phone number with spaces
      // e.g. "+91 98765 43210" or "+1 415 555 2671"
      const wholeSanitized = sanitizePhoneNumber(line);
      if (wholeSanitized !== null) {
        tryAddContact(line, '', line);
      } else {
        // Line could not be parsed as any phone number
        invalidLines.push(line);
      }
    }
  }

  return {
    contacts,
    duplicatesCount,
    invalidCount: invalidLines.length,
    invalidLines,
  };
}

/**
 * Masks phone numbers to prevent privacy leaks in shared environments or logs.
 * Example: 919876543210 -> +91 98765 •••••
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') return '••••••';
  const clean = phone.replace(/\D/g, '');
  if (clean.length < 7) return '••••••';

  // For 12-digit Indian numbers (91 + 10 digits)
  if (clean.startsWith('91') && clean.length === 12) {
    const mobilePrefix = clean.slice(2, 6); // First 4 mobile digits
    return `+91 ${mobilePrefix} •••••`;
  }

  const prefix = clean.slice(0, Math.min(5, clean.length - 4));
  const suffix = clean.slice(-2);
  const maskedLength = Math.max(3, clean.length - prefix.length - suffix.length);
  return `+${prefix} ${'•'.repeat(maskedLength)} ${suffix}`;
}

/**
 * Masks individual names to prevent identity leakage.
 * Example: Rahul Verma -> R•••• V••••
 */
export function maskName(name: string): string {
  if (!name || typeof name !== 'string' || name.trim() === 'Member') return 'Member';
  const parts = name.trim().split(/\s+/);
  return parts
    .map(p => {
      if (p.length <= 1) return p;
      return p[0] + '•'.repeat(Math.min(4, p.length - 1));
    })
    .join(' ');
}
