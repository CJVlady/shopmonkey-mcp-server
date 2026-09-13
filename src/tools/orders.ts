import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, sanitizePathParam, getDefaultLocationId } from '../client.js';
import type { Order } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';
import { pickFields } from '../types/tools.js';

export const definitions: Tool[] = [
  {
    name: 'list_orders',
    description: 'List work orders from Shopmonkey. Filter by status, customer ID, date range, or location.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['Estimate', 'RepairOrder', 'Invoice'], description: 'Filter by order status' },
        customerId: { type: 'string', description: 'Filter orders by customer ID' },
        locationId: { type: 'string', description: 'Filter by location ID (for multi-location shops). Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
    },
  },
  {
    name: 'get_order',
    description: 'Get detailed information about a single work order by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The work order ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_order',
    description:
      'Create a new work order in Shopmonkey. Note that the API frequently ignores `status` on create and returns an Estimate; this tool detects that and corrects it with a follow-up update, reporting what it had to do.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer ID to associate with the order' },
        vehicleId: { type: 'string', description: 'Vehicle ID to associate with the order' },
        status: { type: 'string', enum: ['Estimate', 'RepairOrder', 'Invoice'], description: 'Initial order status' },
        locationId: { type: 'string', description: 'Location ID for multi-location shops. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        name: { type: 'string', description: 'Order title shown on the work order (e.g. "Front brake job")' },
        complaint: { type: 'string', description: "Customer's stated concern. This is the order-level note field — what the customer told you." },
        recommendation: { type: 'string', description: 'Shop recommendation / suggested approach, stored alongside the complaint.' },
      },
    },
  },
  {
    name: 'update_service',
    description:
      "Update a service already on a work order — its note or its name. Use this to set a service note, because add_service_to_order's note is overwritten by the canned service's own note when one is copied in. The write is verified by read-back.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        orderId: { type: 'string', description: 'The work order ID the service belongs to' },
        serviceId: { type: 'string', description: 'The service ID to update (from list_services)' },
        note: { type: 'string', description: 'Service note text' },
        name: { type: 'string', description: 'Service name' },
      },
      required: ['orderId', 'serviceId'],
    },
  },
  {
    name: 'update_order',
    description:
      'Update fields on an existing work order, including its notes. Every write is read back and the result reports which fields actually persisted — this API accepts unknown or unsupported fields, ignores them, and still answers 200.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The work order ID to update' },
        status: { type: 'string', enum: ['Estimate', 'RepairOrder', 'Invoice'], description: 'New order status' },
        customerId: { type: 'string', description: 'New customer ID' },
        vehicleId: { type: 'string', description: 'New vehicle ID' },
        name: { type: 'string', description: 'New order title' },
        complaint: { type: 'string', description: "Customer's stated concern. This is the order-level note field — what the customer told you." },
        recommendation: { type: 'string', description: 'Shop recommendation / suggested approach, stored alongside the complaint.' },
      },
      required: ['id'],
    },
  },
];

const UPDATE_FIELDS = ['status', 'customerId', 'vehicleId', 'name', 'complaint', 'recommendation'];
const CREATE_FIELDS = ['customerId', 'vehicleId', 'status', 'locationId', 'name', 'complaint', 'recommendation'];

/** Fields whose stored value should be compared against what was sent. */
const VERIFIED_FIELDS = ['status', 'name', 'complaint', 'recommendation', 'customerId', 'vehicleId'];

function diffApplied(sent: Record<string, unknown>, stored: Record<string, unknown>) {
  const applied: string[] = [];
  const ignored: Record<string, unknown> = {};
  for (const key of VERIFIED_FIELDS) {
    if (!(key in sent)) continue;
    if (stored[key] === sent[key]) applied.push(key);
    else ignored[key] = { requested: sent[key], stored: stored[key] ?? null };
  }
  return { applied, ignored };
}

function applyDefaultLocation(params: Record<string, string>): void {
  if (!params.locationId) {
    const defaultId = getDefaultLocationId();
    if (defaultId) params.locationId = defaultId;
  }
}

export const handlers: ToolHandlerMap = {
  async list_orders(args) {
    const params: Record<string, string> = {};
    if (args.status !== undefined) params.status = String(args.status);
    if (args.customerId !== undefined) params.customerId = String(args.customerId);
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.skip !== undefined) params.skip = String(args.skip);
    applyDefaultLocation(params);

    const data = await shopmonkeyRequest<Order[]>('GET', '/order', undefined, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async get_order(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const data = await shopmonkeyRequest<Order>('GET', `/order/${sanitizePathParam(String(args.id))}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async create_order(args) {
    const body = pickFields(args, CREATE_FIELDS);
    if (!body.locationId) {
      const defaultId = getDefaultLocationId();
      if (defaultId) body.locationId = defaultId;
    }

    let order = await shopmonkeyRequest<Order>('POST', '/order', body);
    const id = String((order as unknown as Record<string, unknown>).id ?? '');
    const corrections: string[] = [];

    // POST /order accepts `status` and creates an Estimate regardless. A
    // follow-up PUT does honour it, so the discrepancy is repaired here rather
    // than left for the caller to notice — or not notice.
    let stored = order as unknown as Record<string, unknown>;
    let { ignored } = diffApplied(body, stored);
    if (id && Object.keys(ignored).length > 0) {
      const retry = pickFields(ignored as Record<string, unknown>, UPDATE_FIELDS);
      for (const k of Object.keys(retry)) retry[k] = body[k];
      if (Object.keys(retry).length > 0) {
        order = await shopmonkeyRequest<Order>('PUT', `/order/${sanitizePathParam(id)}`, retry);
        stored = order as unknown as Record<string, unknown>;
        corrections.push(...Object.keys(retry));
        ignored = diffApplied(body, stored).ignored;
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({
        created: true,
        id: stored.id,
        number: stored.number,
        correctedAfterCreate: corrections,
        stillNotApplied: Object.keys(ignored).length > 0 ? ignored : undefined,
        order,
      }, null, 2) }],
    };
  },

  async update_order(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const id = sanitizePathParam(String(args.id));
    const body = pickFields(args, UPDATE_FIELDS);
    if (Object.keys(body).length === 0) {
      return { content: [{ type: 'text', text: 'Error: nothing to update — pass at least one field' }], isError: true };
    }

    const order = await shopmonkeyRequest<Order>('PUT', `/order/${id}`, body);
    const { applied, ignored } = diffApplied(body, order as unknown as Record<string, unknown>);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        id: args.id,
        applied,
        ignored: Object.keys(ignored).length > 0 ? ignored : undefined,
        allApplied: Object.keys(ignored).length === 0,
        order,
      }, null, 2) }],
      isError: applied.length === 0,
    };
  },

  async update_service(args) {
    if (!args.orderId) return { content: [{ type: 'text', text: 'Error: orderId is required' }], isError: true };
    if (!args.serviceId) return { content: [{ type: 'text', text: 'Error: serviceId is required' }], isError: true };

    const orderId = sanitizePathParam(String(args.orderId));
    const serviceId = sanitizePathParam(String(args.serviceId));
    const body = pickFields(args, ['name', 'note']);
    if (Object.keys(body).length === 0) {
      return { content: [{ type: 'text', text: 'Error: pass a name or a note to change' }], isError: true };
    }

    await shopmonkeyRequest('PUT', `/order/${orderId}/service/${serviceId}`, body);

    // Read back from the service list, the one place services reliably appear.
    const services = await shopmonkeyRequest<unknown[]>('GET', `/order/${orderId}/service`);
    const found = (Array.isArray(services) ? services : [])
      .map((s) => s as Record<string, unknown>)
      .find((s) => String(s.id) === String(args.serviceId));

    const { applied, ignored } = (() => {
      const a: string[] = []; const ig: Record<string, unknown> = {};
      for (const k of Object.keys(body)) {
        if (found && found[k] === body[k]) a.push(k);
        else ig[k] = { requested: body[k], stored: found ? found[k] ?? null : 'service not found after update' };
      }
      return { applied: a, ignored: ig };
    })();

    return {
      content: [{ type: 'text', text: JSON.stringify({
        orderId: args.orderId,
        serviceId: args.serviceId,
        applied,
        ignored: Object.keys(ignored).length > 0 ? ignored : undefined,
        allApplied: Object.keys(ignored).length === 0,
        service: found ?? null,
      }, null, 2) }],
      isError: applied.length === 0,
    };
  },
};
