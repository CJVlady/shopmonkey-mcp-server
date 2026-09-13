import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, sanitizePathParam, getDefaultLocationId } from '../client.js';
import type { Labor, TimeclockEntry, User } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';

export const definitions: Tool[] = [
  {
    name: 'list_labor',
    description: 'List the labor line items on a service. Shopmonkey nests labor under order > service, so both orderId and serviceId are required — call list_services with an orderId first to get the serviceId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        orderId: { type: 'string', description: 'The work order ID the service belongs to' },
        serviceId: { type: 'string', description: 'The service ID to list labor line items for' },
      },
      required: ['orderId', 'serviceId'],
    },
  },
  {
    name: 'assign_technician',
    description:
      "Assign a technician to labor line items on a work order. Give it the orderId and a technicianId from list_users; " +
      'omit laborIds to assign every labor line on the order, which is the usual intent. ' +
      'Each assignment is read back and verified, and the result reports per line whether it actually took.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        orderId: { type: 'string', description: 'The work order ID the labor line items belong to' },
        laborIds: { type: 'array', items: { type: 'string' }, description: 'Labor line item IDs to assign. Omit to assign every labor line on the order.' },
        technicianId: { type: 'string', description: 'The technician/user ID to assign (from list_users)' },
      },
      required: ['orderId', 'technicianId'],
    },
  },
  {
    name: 'list_timeclock',
    description: 'List technician time clock events. Track clock-in/clock-out for shop staff.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'Filter by user/technician ID' },
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
        startDate: { type: 'string', description: 'Filter by start date (ISO 8601 format)' },
        endDate: { type: 'string', description: 'Filter by end date (ISO 8601 format)' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
        skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
      },
    },
  },
  {
    name: 'list_users',
    description: 'List shop users and technicians from Shopmonkey.',
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
    name: 'get_user',
    description: 'Get detailed information about a single shop user or technician by their ID.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'The user/technician ID' } }, required: ['id'] },
  },
];

function applyDefaultLocation(params: Record<string, string>): void {
  if (!params.locationId) {
    const defaultId = getDefaultLocationId();
    if (defaultId) params.locationId = defaultId;
  }
}

export const handlers: ToolHandlerMap = {
  async list_labor(args) {
    if (!args.orderId) return { content: [{ type: 'text', text: 'Error: orderId is required' }], isError: true };
    if (!args.serviceId) return { content: [{ type: 'text', text: 'Error: serviceId is required' }], isError: true };

    const data = await shopmonkeyRequest<Labor[]>(
      'GET',
      `/order/${sanitizePathParam(String(args.orderId))}/service/${sanitizePathParam(String(args.serviceId))}/labor`
    );
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async assign_technician(args) {
    if (!args.orderId) return { content: [{ type: 'text', text: 'Error: orderId is required' }], isError: true };
    if (!args.technicianId) return { content: [{ type: 'text', text: 'Error: technicianId is required' }], isError: true };

    const orderId = sanitizePathParam(String(args.orderId));
    const technicianId = String(args.technicianId);
    const requested = Array.isArray(args.laborIds) ? args.laborIds.map(String) : null;

    // Labor lives at order > service > labor, and a labor id alone is not
    // enough to address it. The order is read first to map each labor line to
    // its parent service, which also means the caller can omit laborIds and
    // get every line on the order.
    //
    // The documented bulk route, PUT /order/:id/labor_bulk, answers "Route not
    // found" on a live shop, so each line is written individually via
    // PUT /order/:orderId/service/:serviceId/labor/:laborId — which is also
    // documented, and does exist.
    const order = await shopmonkeyRequest<{ services?: unknown[] }>('GET', `/order/${orderId}`);
    const services = Array.isArray(order?.services) ? order.services : [];

    const targets: { laborId: string; serviceId: string; name: string }[] = [];
    for (const s of services) {
      const svc = s as Record<string, unknown>;
      const serviceId = String(svc.id ?? '');
      const labors = Array.isArray(svc.labors) ? svc.labors : [];
      for (const l of labors) {
        const lab = l as Record<string, unknown>;
        const laborId = String(lab.id ?? '');
        if (!laborId || !serviceId) continue;
        if (requested && !requested.includes(laborId)) continue;
        targets.push({ laborId, serviceId, name: String(lab.name ?? '') });
      }
    }

    if (targets.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'no matching labor line items',
          detail: requested
            ? 'None of the given laborIds were found on this order. Labor ids are per-order; check them with list_services / list_labor.'
            : 'This order has no labor line items yet. Add a service with labor before assigning a technician.',
        }, null, 2) }],
        isError: true,
      };
    }

    const results: Record<string, unknown>[] = [];
    for (const t of targets) {
      try {
        await shopmonkeyRequest(
          'PUT',
          `/order/${orderId}/service/${sanitizePathParam(t.serviceId)}/labor/${sanitizePathParam(t.laborId)}`,
          { technicianId }
        );
        results.push({ laborId: t.laborId, name: t.name, assigned: 'pending verification' });
      } catch (err) {
        results.push({ laborId: t.laborId, name: t.name, assigned: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Read the order back. Shopmonkey accepts unknown fields and answers 200
    // without applying them, so a successful PUT is not evidence the
    // technician was set — only the stored value is.
    const after = await shopmonkeyRequest<{ services?: unknown[] }>('GET', `/order/${orderId}`);
    const stored = new Map<string, unknown>();
    for (const s of (Array.isArray(after?.services) ? after.services : [])) {
      for (const l of (Array.isArray((s as Record<string, unknown>).labors) ? (s as Record<string, unknown>).labors as unknown[] : [])) {
        const lab = l as Record<string, unknown>;
        stored.set(String(lab.id), lab.technicianId);
      }
    }

    let confirmed = 0;
    for (const r of results) {
      const actual = stored.get(String(r.laborId));
      const ok = actual === technicianId;
      r.assigned = ok;
      if (ok) confirmed++;
      else if (!r.error) r.error = `technicianId is ${actual === null || actual === undefined ? 'still unset' : String(actual)} after the write`;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({
        orderId: args.orderId,
        technicianId,
        laborLines: targets.length,
        confirmed,
        allConfirmed: confirmed === targets.length,
        results,
      }, null, 2) }],
      isError: confirmed === 0,
    };
  },

  async list_timeclock(args) {
    const params: Record<string, string> = {};
    if (args.userId !== undefined) params.userId = String(args.userId);
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    if (args.startDate !== undefined) params.startDate = String(args.startDate);
    if (args.endDate !== undefined) params.endDate = String(args.endDate);
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.skip !== undefined) params.skip = String(args.skip);
    applyDefaultLocation(params);

    const data = await shopmonkeyRequest<TimeclockEntry[]>('GET', '/timeclock', undefined, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async list_users(args) {
    const params: Record<string, string> = {};
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    if (args.limit !== undefined) params.limit = String(args.limit);
    if (args.skip !== undefined) params.skip = String(args.skip);
    applyDefaultLocation(params);

    const data = await shopmonkeyRequest<User[]>('GET', '/user', undefined, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },

  async get_user(args) {
    if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    const data = await shopmonkeyRequest<User>('GET', `/user/${sanitizePathParam(String(args.id))}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
};
