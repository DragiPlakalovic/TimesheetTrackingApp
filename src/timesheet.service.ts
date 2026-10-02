import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, concat } from 'rxjs';
import { last, switchMap } from 'rxjs/operators';

/** POST /users */
export interface CreateUserRequest {
  name: string;
  email: string;
}

/** User JSON from the API */
export interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

/** POST /timesheets */
export interface CreateTimesheetRequest {
  user_id: number;
  period_start: string;
  period_end: string;
}

/** POST /timesheets/:id/entries */
export interface CreateEntryRequest {
  work_date: string;
  hours: number;
  description: string;
}

/** Daily entry JSON from the API */
export interface DailyTimesheetEntry {
  id: number;
  timesheet_id: number;
  work_date: string;
  hours: number;
  description: string;
}

/** Timesheet JSON from the API */
export interface Timesheet {
  id: number;
  user_id: number;
  period_start: string;
  period_end: string;
  status: 'draft' | 'submitted' | 'approved';
  submitted_at: string | null;
  total_hours: number;
  created_at: string;
  entries?: DailyTimesheetEntry[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
}

export interface SubmitWeekRequest {
  user_id: number;
  period_start: string;
  period_end: string;
  entries: CreateEntryRequest[];
}

@Injectable({ providedIn: 'root' })
export class TimesheetService {
  private http = inject(HttpClient);

  listUsers(): Observable<Paginated<User>> {
    return this.http.get<Paginated<User>>('/users', { params: { per_page: 100 } });
  }

  createUser(body: CreateUserRequest): Observable<User> {
    return this.http.post<User>('/users', body);
  }

  createTimesheet(body: CreateTimesheetRequest): Observable<Timesheet> {
    return this.http.post<Timesheet>('/timesheets', body);
  }

  createEntry(timesheetId: number, body: CreateEntryRequest): Observable<DailyTimesheetEntry> {
    return this.http.post<DailyTimesheetEntry>(`/timesheets/${timesheetId}/entries`, body);
  }

  submitTimesheet(timesheetId: number): Observable<Timesheet> {
    return this.http.post<Timesheet>(`/timesheets/${timesheetId}/submit`, {});
  }

  getTimesheet(timesheetId: number): Observable<Timesheet> {
    return this.http.get<Timesheet>(`/timesheets/${timesheetId}`);
  }

  /**
   * Creates a timesheet, posts each daily entry, then submits.
   * Request bodies match the Flask API; the final value is GET /timesheets/:id.
   */
  submitWeek(body: SubmitWeekRequest): Observable<Timesheet> {
    return this.createTimesheet({
      user_id: body.user_id,
      period_start: body.period_start,
      period_end: body.period_end,
    }).pipe(
      switchMap(ts => {
        const posts = body.entries
          .filter(e => e.hours > 0)
          .map(entry => this.createEntry(ts.id, entry));
        return concat(...posts, this.submitTimesheet(ts.id)).pipe(
          last(),
          switchMap(() => this.getTimesheet(ts.id)),
        );
      }),
    );
  }
}
