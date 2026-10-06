import nestClient from '../nest-client';
import type { Appointment, AppointmentCreatePayload } from '../../types/appointment';

/** Fetch all appointments (with optional date filters via query params) */
export async function getAppointments(params?: {
  date?: string;
  startDate?: string;
  endDate?: string;
  provider?: string;
}): Promise<Appointment[]> {
  const response = await nestClient.get('/appointments', { params });
  return response.data;
}

/** Fetch a single appointment by EID */
export async function getAppointment(eid: number): Promise<Appointment> {
  const response = await nestClient.get(`/appointments/${eid}`);
  return response.data;
}

/** Fetch appointments for a specific patient */
export async function getPatientAppointments(pid: string): Promise<Appointment[]> {
  const response = await nestClient.get(`/patients/${pid}/appointments`);
  return response.data;
}

/** Create a new appointment for a patient */
export async function createAppointment(
  pid: string,
  data: AppointmentCreatePayload,
): Promise<Appointment> {
  const response = await nestClient.post(`/patients/${pid}/appointments`, data);
  return response.data;
}

/** Delete an appointment */
export async function deleteAppointment(pid: string, eid: number): Promise<void> {
  await nestClient.delete(`/patients/${pid}/appointments/${eid}`);
}
