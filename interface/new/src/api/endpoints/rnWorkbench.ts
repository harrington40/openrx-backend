import nestClient from '../nest-client';

/**
 * RN workbench endpoints: code/isolation flags, fall & Braden assessments,
 * intake/output, SBAR handover, escalation, the task board and workload.
 */
export async function getFlags(pid: number | string): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/flags`)).data;
}
export async function setFlags(pid: number | string, data: any): Promise<any> {
    return (await nestClient.patch(`/patients/${pid}/flags`, data)).data;
}

export async function getSafety(pid: number | string): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/safety`)).data;
}
export async function saveSafety(
    pid: number | string,
    kind: 'fall' | 'braden',
    data: any,
): Promise<any> {
    return (await nestClient.post(`/patients/${pid}/safety/${kind}`, data)).data;
}

export async function getIO(pid: number | string): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/io`)).data;
}
export async function addIO(pid: number | string, data: any): Promise<any> {
    return (await nestClient.post(`/patients/${pid}/io`, data)).data;
}

export async function getHandover(pid: number | string): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/handover`)).data;
}

export async function escalate(
    pid: number | string,
    reason: string,
): Promise<any> {
    return (await nestClient.post(`/patients/${pid}/escalate`, { reason })).data;
}

export async function listTasks(): Promise<any[]> {
    return (await nestClient.get('/nurse/tasks')).data;
}
export async function createTask(data: any): Promise<any> {
    return (await nestClient.post('/nurse/tasks', data)).data;
}
export async function completeTask(id: number | string): Promise<any> {
    return (await nestClient.post(`/nurse/tasks/${id}/complete`, {})).data;
}

export async function getWorkload(): Promise<any[]> {
    return (await nestClient.get('/nurse/workload')).data;
}

export async function getMedicationFollowUps(): Promise<any[]> {
    return (await nestClient.get('/medication-administration/follow-ups')).data;
}

export async function getPatient360(pid: number | string): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/360`)).data;
}

export async function getChecklist(
    pid: number | string,
    kind: 'admission' | 'discharge' = 'admission',
): Promise<any> {
    return (await nestClient.get(`/patients/${pid}/checklist`, { params: { kind } })).data;
}

