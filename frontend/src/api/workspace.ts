import { apiFetch } from './client';
import {
  Area,
  Dorm,
  Employee,
  MaintenanceTicket,
  Property,
  Room,
  Task,
  Washroom,
  Zone,
} from '../types';
import { ListResponse } from './types';

/**
 * One-shot aggregate of every collection the app bootstraps on sign-in
 * (B-04). Per-key shapes mirror the individual list endpoints, so the
 * context unpacks each `items` list exactly as before — one HTTP request,
 * one auth lookup, one DB-session-per-collection fan-out server-side.
 */
export interface WorkspaceBootstrap {
  properties: ListResponse<Property>;
  areas: ListResponse<Area>;
  zones: ListResponse<Zone>;
  rooms: ListResponse<Room>;
  dorms: ListResponse<Dorm>;
  washrooms: ListResponse<Washroom>;
  employees: ListResponse<Employee>;
  tasks: ListResponse<Task>;
  maintenance: ListResponse<MaintenanceTicket>;
}

export async function getWorkspace(): Promise<WorkspaceBootstrap> {
  return apiFetch<WorkspaceBootstrap>('/workspace');
}
