import nestClient from '../nest-client';

/**
 * Medication-administration (MAR) endpoints.
 *
 * A patient becomes part of the MAR when they are hospitalized; the backend then
 * derives the scheduled doses from their active prescriptions and notifies the
 * assigned nurse. The bedside administration is passed through the backend's
 * smart safety check (allergy hard-stops, high-alert medicines, dose/timing).
 */
export interface MedicationDashboard {
  summary: {
    hospitalized: number;
    scheduled: number;
    dueNow: number;
    overdue: number;
    highAlert: number;
    unreadAlerts: number;
  };
  due: any[];
  highAlert: any[];
  alerts: any[];
  generatedAt: string;
}

export async function getMedicationDashboard(): Promise<MedicationDashboard> {
  const response = await nestClient.get('/medication-administration/dashboard');
  return response.data;
}

export async function getMedicationAlerts(): Promise<{ unread: number; alerts: any[] }> {
  const response = await nestClient.get('/medication-administration/alerts');
  return response.data;
}

export async function getPatientMedicationOrders(pid: number | string): Promise<any[]> {
  const response = await nestClient.get(`/patients/${pid}/medication-orders`);
  return response.data;
}

export async function hospitalizePatient(
  pid: number | string,
  room: string,
  nurseId?: number,
): Promise<any> {
  const response = await nestClient.post(`/patients/${pid}/hospitalize`, { room, nurseId });
  return response.data;
}

export async function dischargePatient(pid: number | string): Promise<any> {
  const response = await nestClient.post(`/patients/${pid}/discharge`, {});
  return response.data;
}

export async function administerMedicationOrder(
  orderId: number | string,
  payload: {
    patientId: number | string;
    dose?: string | number;
    route?: string | null;
    overrideReason?: string;
    witnessBy?: number | string;
    notes?: string;
    patientBarcode?: string;
    drugBarcode?: string;
  },
): Promise<any> {
  const response = await nestClient.post(
    `/medication-administration/orders/${orderId}/administer`,
    payload,
  );
  return response.data;
}

export async function ackMedicationAlert(id: number | string): Promise<any> {
  const response = await nestClient.post(`/medication-administration/alerts/${id}/ack`, {});
  return response.data;
}

export async function ackAllMedicationAlerts(): Promise<any> {
  const response = await nestClient.post('/medication-administration/alerts/read-all', {});
  return response.data;
}
