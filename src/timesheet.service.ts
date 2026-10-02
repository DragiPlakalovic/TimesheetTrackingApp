import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface TimesheetEntry {
  project: string;
  task: string;
  mon: number; tue: number; wed: number; thu: number; fri: number; sat: number; sun: number;
}

export interface Timesheet {
  employee: string;
  weekStarting: string;
  entries: TimesheetEntry[];
  totalHours: number;
}

export interface TimesheetResponse extends Timesheet {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class TimesheetService {
  private http = inject(HttpClient);
  // Proxied to your backend in dev (see proxy.conf.json); change for production.
  private readonly baseUrl = '/api/timesheets';

  submit(timesheet: Timesheet): Observable<TimesheetResponse> {
    return this.http.post<TimesheetResponse>(this.baseUrl, timesheet);
  }

  getForWeek(employee: string, weekStarting: string): Observable<TimesheetResponse | null> {
    return this.http.get<TimesheetResponse | null>(this.baseUrl, {
      params: { employee, weekStarting },
    });
  }
}