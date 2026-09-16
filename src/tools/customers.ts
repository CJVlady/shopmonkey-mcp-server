// Email and phone are sub-resources in Shopmonkey. After creating a customer, use POST /v3/customer/:id/email
// and POST /v3/customer/:id/phone_number to attach contact info. Those sub-resource tools are tracked in Spec 2.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, fetchAllRecordsPost, sanitizePathParam, getDefaultLocationId } from '../client.js';
import type { Customer } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';
import { pickFields } from '../types/tools.js';

export const definitions: Tool[] = [
  {
    name: 'search_customers',
    description:
      'Find customers in Shopmonkey by name, email address, phone number or legacy external id. Matching is case-insensitive and word order does not matter. ' +
      'Normally filters server-side and an empty result is meaningful. ALWAYS read the returned `coverage` field: if filtering says "client-side fallback", a zero result does NOT prove the customer is absent, because this endpoint does not reliably enumerate every record. ' +
      'Nicknames do not resolve — searching "Tony" will not find "Anthony". ' +
      'Returns compact summaries; use get_customer with an id for the full record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Name, email or phone to search for. Substring, case-insensitive, word order independent.' },
        where: { type: 'object', description: 'Raw Shopmonkey filter object, passed through verbatim. For probing the API filter syntax; leave unset for normal use.' },
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
    },
  },
  {
    name: 'search_customers_by_email',
    description: 'Search for a customer in Shopmonkey by email address.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Customer email address to search for' },
      },
      required: ['email'],
    },
  },
  {
    name: 'search_customers_by_phone',
    description: 'Search for a customer in Shopmonkey by phone number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phoneNumber: { type: 'string', description: 'Customer phone number to search for' },
      },
      required: ['phoneNumber'],
    },
  },
  {
    name: 'get_customer',
    description: 'Get detailed information about a single customer by their ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The customer ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new customer in Shopmonkey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        firstName: { type: 'string', description: 'Customer first name' },
        lastName: { type: 'string', description: 'Customer last name' },
        address: { type: 'string', description: 'Street address' },
        city: { type: 'string', description: 'City' },
        state: { type: 'string', description: 'State' },
        zip: { type: 'string', description: 'ZIP code' },
      },
    },
  },
  {
    name: 'update_customer',
    description: 'Update an existing customer\'s information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The customer ID to update' },
        firstName: { type: 'string', description: 'Customer first name' },
        lastName: { type: 'string', description: 'Customer last name' },
        address: { type: 'string', description: 'Street address' },
        city: { type: 'string', description: 'City' },
        state: { type: 'string', description: 'State' },
        zip: { type: 'string', description: 'ZIP code' },
      },
      required: ['id'],
    },
  },
];

const ALLOWED_FIELDS = ['firstName', 'lastName', 'address', 'city', 'state', 'zip'];
const SEARCH_FIELDS = ['query', 'limit', 'skip', 'locationId', 'where'];

function applyDefaultLocation(body: Record<string, unknown>): void {
  if (!body.locationId) {
    const defaultId = getDefaultLocationId();
    if (defaultId) body.locationId = defaultId;
  }
}

function jsonResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Substring matching over the fields a human would search by.
 *
 * Tokens are matched independently, so word order does not matter and a query
 * copied off a customer list still lands. "Tony & Lucy Gargano" finds the
 * record filed as "Anthony Gargano" with the email "mslucyg@aol.com": the
 * punctuation is dropped, "gargano" and "lucy" both hit, and the weighting in
 * rankCustomerMatches puts it above the "Tonya" that "tony" also matches.
 *
 * Note what this does NOT do: "tony" is not a substring of "anthony" — the
 * letters run "thony" — so a bare nickname finds nothing. Resolving nicknames
 * would need a synonym table, which this deliberately does not have.
 */
function customerHaystack(c: Customer): string {
  const record = c as unknown as Record<string, unknown>;
  const emails = Array.isArray(record.emails) ? record.emails : [];
  const phones = Array.isArray(record.phoneNumbers) ? record.phoneNumbers : [];
  return [
    record.firstName,
    record.lastName,
    record.companyName,
    record.normalizedName,
    record.externalId,
    ...emails.map((e) => (e as Record<string, unknown>)?.email),
    ...phones.map((p) => (p as Record<string, unknown>)?.number),
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .toLowerCase();
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9@.+-]{2,}/g) ?? [];
}

export function rankCustomerMatches(records: Customer[], query: string): Customer[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const scored = records.map((c) => {
    const hay = customerHaystack(c);
    const hit = tokens.filter((t) => hay.includes(t));
    // Partial matches are ranked by how specific the matched tokens are, not
    // merely how many landed. Searching "Tony Gargano" matches "Tonya Deem" on
    // the short token and "Anthony Gargano" on the long one; one of those is
    // obviously the intended person, and token length is what says so.
    const weight = hit.reduce((sum, t) => sum + t.length, 0);
    return { c, hits: hit.length, weight };
  });

  const full = scored.filter((s) => s.hits === tokens.length);
  if (full.length > 0) return full.map((s) => s.c);

  return scored
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.weight - a.weight || b.hits - a.hits)
    .map((s) => s.c);
}

/** Full customer records are large enough that a page of them can blow a model's context. */
function summariseCustomer(c: Customer): Record<string, unknown> {
  const record = c as unknown as Record<string, unknown>;
  const emails = Array.isArray(record.emails) ? record.emails : [];
  const phones = Array.isArray(record.phoneNumbers) ? record.phoneNumbers : [];
  return {
    id: record.id,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    companyName: record.companyName ?? null,
    emails: emails.map((e) => (e as Record<string, unknown>)?.email).filter(Boolean),
    phoneNumbers: phones.map((p) => (p as Record<string, unknown>)?.number).filter(Boolean),
    city: record.city ?? null,
    state: record.state ?? null,
    orderCount: record.orderCount ?? 0,
    vehicleCount: record.vehicleCount ?? 0,
    externalId: record.externalId ?? null,
    createdDate: record.createdDate ?? null,
  };
}

export const handlers: ToolHandlerMap = {
  async search_customers(args) {
    const base = pickFields(args, SEARCH_FIELDS);
    applyDefaultLocation(base);
    delete base.query; delete base.limit; delete base.skip; delete base.where;

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    const skip = typeof args.skip === 'number' ? args.skip : 0;
    const rawWhere = args.where && typeof args.where === 'object' ? (args.where as Record<string, unknown>) : null;

    // Escape hatch for probing filter syntax by hand.
    if (rawWhere) {
      const { records, truncated } = await fetchAllRecordsPost<Customer>(
        '/customer/search', { ...base, where: rawWhere }, { maxRecords: 1000 }
      );
      return jsonResult({
        query: query || null, filtering: 'raw where passthrough', whereUsed: rawWhere,
        matched: records.length, truncated,
        results: records.slice(skip, skip + limit).map(summariseCustomer),
      });
    }

    // Server-side filtering, one token at a time.
    //
    // `{ normalizedName: { contains: <term> } }` is honoured by Shopmonkey; the
    // `like`/`%` form documented for other systems is silently ignored here,
    // answering 200 with an unfiltered page. `contains` takes a single
    // substring, so a multi-word query sent whole matches nothing — "tony &
    // lucy gargano" is not a substring of "anthony gargano". Each token is
    // therefore requested separately and the results unioned, with ranking
    // left to rankCustomerMatches.
    //
    // Every response is checked against the term that asked for it. If the API
    // ever stops honouring `contains`, that check fails and the scan below
    // runs instead, rather than a silent wrong answer.
    const tokens = query ? queryTokens(query) : [];
    if (tokens.length > 0) {
      const union = new Map<unknown, Customer>();
      let serverFiltered = true;
      let anyTruncated = false;

      for (const token of tokens) {
        try {
          const { records, truncated } = await fetchAllRecordsPost<Customer>(
            '/customer/search',
            { ...base, where: { normalizedName: { contains: token } } },
            { maxRecords: 1000 }
          );
          const honoured = records.every((r) => {
            const n = (r as unknown as Record<string, unknown>).normalizedName;
            return typeof n === 'string' && n.toLowerCase().includes(token);
          });
          if (!honoured) { serverFiltered = false; break; }
          anyTruncated = anyTruncated || truncated;
          for (const r of records) {
            const id = (r as unknown as Record<string, unknown>).id;
            if (id !== undefined) union.set(id, r);
          }
        } catch {
          serverFiltered = false;
          break;
        }
      }

      if (serverFiltered) {
        const ranked = rankCustomerMatches([...union.values()], query);
        const page = ranked.slice(skip, skip + limit);
        return jsonResult({
          query,
          filtering: 'server-side (per-token contains)',
          tokensSearched: tokens,
          matched: ranked.length,
          returned: page.length,
          truncated: anyTruncated,
          coverage: anyTruncated
            ? 'A term matched more records than the cap allows; results are partial.'
            : 'Shopmonkey applied the filter and every response was verified against the term that requested it. An empty result means no customer name contains these terms — though a customer could still be reachable by email or phone.',
          results: page.map(summariseCustomer),
        });
      }
    }

    // Fallback: the server filter was not honoured, or there is no query.
    const { records, truncated } = await fetchAllRecordsPost<Customer>('/customer/search', base, { maxRecords: 5000 });
    const matched = query ? rankCustomerMatches(records, query) : records;
    const page = matched.slice(skip, skip + limit);

    return jsonResult({
      query: query || null,
      filtering: 'client-side fallback',
      matched: matched.length,
      returned: page.length,
      scanned: records.length,
      truncated,
      coverage:
        'WARNING — the server-side filter was not honoured, so this fell back to reading pages and filtering here. ' +
        'This endpoint does not reliably enumerate every customer: repeated scans of the same shop return different totals, and records confirmed to exist have been absent from a full page-through. ' +
        `${records.length} records were reached${truncated ? ' before the scan cap' : ''}, which is a sample, not the whole customer list. ` +
        'A zero result here is NOT proof the customer is absent. Confirm with search_customers_by_email, search_customers_by_phone, or the Shopmonkey web UI before creating a new customer record.',
      results: page.map(summariseCustomer),
    });
  },

  async search_customers_by_email(args) {
    if (!args.email) return { content: [{ type: 'text', text: 'Error: email is required' }], isError: true };
    const data = await shopmonkeyRequest<Customer[]>('POST', '/customer/email/search', { emails: [String(args.email)] });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async search_customers_by_phone(args) {
    if (!args.phoneNumber) return { content: [{ type: 'text', text: 'Error: phoneNumber is required' }], isError: true };
    const data = await shopmonkeyRequest<Customer[]>('POST', '/customer/phone_number/search', { phoneNumbers: [{ number: String(args.phoneNumber) }] });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async get_customer(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const data = await shopmonkeyRequest<Customer>('GET', `/customer/${sanitizePathParam(String(args.id))}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async create_customer(args) {
    const body = pickFields(args, ALLOWED_FIELDS);
    const data = await shopmonkeyRequest<Customer>('POST', '/customer', body);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async update_customer(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const body = pickFields(args, ALLOWED_FIELDS);
    const data = await shopmonkeyRequest<Customer>('PUT', `/customer/${sanitizePathParam(String(args.id))}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
};
