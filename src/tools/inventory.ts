import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, fetchAllRecords, sanitizePathParam, getDefaultLocationId } from '../client.js';
import type { InventoryPart, InventoryTire } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';

export const definitions: Tool[] = [
  {
    name: 'list_inventory_parts',
    description: 'List parts from Shopmonkey inventory. Supports pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
    },
  },
  {
    name: 'get_inventory_part',
    description: 'Get detailed information about a single inventory part by its ID.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'The inventory part ID' } }, required: ['id'] },
  },
  {
    name: 'list_inventory_tires',
    description: 'List tires from Shopmonkey inventory. Supports pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
    },
  },
  {
    name: 'search_parts',
    description: 'Search the parts catalog in Shopmonkey. Use for finding parts by name, number, or description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query for parts (name, part number, or description)' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
      required: ['query'],
    },
  },
];

function applyDefaultLocation(params: Record<string, string>): void {
  if (!params.locationId) {
    const defaultId = getDefaultLocationId();
    if (defaultId) params.locationId = defaultId;
  }
}

export const handlers: ToolHandlerMap = {
  async list_inventory_parts(args) {
    const params: Record<string, string> = {};
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.skip !== undefined) params.skip = String(args.skip);
    applyDefaultLocation(params);

    const data = await shopmonkeyRequest<InventoryPart[]>('GET', '/inventory_part', undefined, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async get_inventory_part(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const data = await shopmonkeyRequest<InventoryPart>('GET', `/inventory_part/${sanitizePathParam(String(args.id))}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async list_inventory_tires(args) {
    const locationId = args.locationId !== undefined ? String(args.locationId) : getDefaultLocationId();
    const body: Record<string, unknown> = {};
    if (args.limit !== undefined) body.limit = Number(args.limit);
    if (args.skip !== undefined) body.skip = Number(args.skip);
    if (locationId) body.where = { locationId };

    const data = await shopmonkeyRequest<InventoryTire[]>('POST', '/inventory_tire/search', body);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async search_parts(args) {
    if (!args.query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
    const query = String(args.query).trim().toLowerCase();
    const tokens = query.match(/[a-z0-9.+-]{2,}/g) ?? [];
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    const skip = typeof args.skip === 'number' ? args.skip : 0;
    const { records } = await fetchAllRecords<InventoryPart>('/inventory_part', undefined, { maxRecords: 1000 });
    const matches = records.filter((part) => {
      const record = part as unknown as Record<string, unknown>;
      const haystack = [record.name, record.number, record.partNumber, record.sku, record.note, record.description]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
    });
    return { content: [{ type: 'text', text: JSON.stringify(matches.slice(skip, skip + limit), null, 2) }] };
  },
};
