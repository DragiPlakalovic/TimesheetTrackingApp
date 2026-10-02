import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormArray, FormBuilder, FormGroup,
  ReactiveFormsModule, Validators,
} from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { finalize, startWith } from 'rxjs';
import {
  CreateEntryRequest,
  SubmitWeekRequest,
  Timesheet,
  TimesheetService,
  User,
} from './timesheet.service';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function mondayOfThisWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toIsoDate(d);
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1, d + n));
}

function apiError(err: HttpErrorResponse): string {
  if (err.status === 0) {
    return "Can't reach the server. Check your connection and try again.";
  }
  const message = typeof err.error?.error === 'string' ? err.error.error : null;
  if (err.status === 400 || err.status === 409 || err.status === 422) {
    return message ?? 'The server rejected this request. Check the fields and try again.';
  }
  return message ?? 'Something went wrong. Try again in a moment.';
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReactiveFormsModule, JsonPipe],
  template: `
    <main>
      <h1>Weekly timesheet</h1>

      <section class="panel">
        <h2>Create user</h2>
        <p class="hint">POSTs <code>{{ '{' }} "name", "email" {{ '}' }}</code> to <code>/users</code>.</p>
        <form class="meta" [formGroup]="userForm" (ngSubmit)="createUser()">
          <label>
            Name
            <input formControlName="name" autocomplete="name" />
          </label>
          <label>
            Email
            <input type="email" formControlName="email" autocomplete="email" />
          </label>
          <div class="field-action">
            <button type="submit" class="ghost" [disabled]="creatingUser()">
              {{ creatingUser() ? 'Creating…' : 'Create user' }}
            </button>
          </div>
        </form>
      </section>

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="meta">
          <label>
            User
            <select formControlName="user_id">
              <option [ngValue]="null">Select a user</option>
              @for (u of users(); track u.id) {
                <option [ngValue]="u.id">{{ u.name }} ({{ u.email }}) — id {{ u.id }}</option>
              }
            </select>
            @if (show('user_id')) { <small class="err">Choose a user.</small> }
          </label>
          <label>
            Period start (Monday)
            <input type="date" formControlName="period_start" />
            @if (show('period_start')) { <small class="err">Choose a date.</small> }
          </label>
          <label>
            Period end
            <input type="date" [value]="periodEnd()" disabled />
          </label>
        </div>

        <div class="grid" formArrayName="entries">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>work_date</th>
                <th class="num">hours</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              @for (row of entries.controls; track row; let i = $index) {
                <tr [formGroupName]="i">
                  <td>{{ days[i] }}</td>
                  <td><input type="date" [value]="row.get('work_date')?.value" disabled /></td>
                  <td class="num">
                    <input type="number" step="0.25" min="0" max="24" formControlName="hours"
                           [attr.aria-label]="days[i] + ' hours'"
                           [class.invalid]="row.get('hours')?.invalid" />
                  </td>
                  <td>
                    <input formControlName="description" placeholder="What you worked on"
                           aria-label="Description" />
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td colspan="2">total_hours</td>
                <td class="num total">{{ grandTotal() }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="actions">
          <button type="submit" class="primary" [disabled]="saving()">
            {{ saving() ? 'Submitting…' : 'Submit timesheet' }}
          </button>
        </div>
      </form>

      @if (error(); as message) {
        <p class="err" role="alert">{{ message }}</p>
      }

      @if (createdUser(); as user) {
        <section class="result">
          <h2>User created</h2>
          <pre>{{ user | json }}</pre>
        </section>
      }

      @if (submitted(); as saved) {
        <section class="result">
          <h2>Timesheet {{ saved.status }} (ID {{ saved.id }})</h2>
          <pre>{{ saved | json }}</pre>
        </section>
      }
    </main>
  `,
  styles: [`
    :host { --ink:#1b2430; --muted:#5d6b7c; --line:#d5dbe3; --bg:#f3f5f7; --accent:#1f4fd8; --bad:#b3261e;
            display:block; background:var(--bg); color:var(--ink); min-height:100vh;
            font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 1040px; margin: 0 auto; padding: 2rem 1rem 4rem; }
    h1 { font-size: 1.75rem; margin: 0 0 1.5rem; letter-spacing: -0.01em; }
    h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
    .hint { color: var(--muted); margin: 0 0 1rem; font-size: .9rem; }
    code { font-size: .85em; }
    .panel { background:#fff; border:1px solid var(--line); border-radius:8px; padding:1rem 1.25rem; margin-bottom:1.5rem; }
    .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    label { display:flex; flex-direction:column; gap:.25rem; font-weight:600; font-size:.9rem; }
    input, select { font:inherit; padding:.45rem .55rem; border:1px solid var(--line); border-radius:6px; background:#fff; color:inherit; width:100%; box-sizing:border-box; }
    input:disabled { background:#f8f9fb; color:var(--muted); }
    input:focus-visible, select:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
    input.invalid { border-color: var(--bad); }
    .field-action { display:flex; align-items:flex-end; }
    .grid { overflow-x:auto; background:#fff; border:1px solid var(--line); border-radius:8px; }
    table { border-collapse:collapse; width:100%; min-width:640px; }
    th, td { padding:.4rem .5rem; text-align:left; border-bottom:1px solid var(--line); }
    th { font-size:.8rem; color:var(--muted); font-weight:600; }
    .num { text-align:right; width:88px; }
    td.num input { text-align:right; padding-inline:.3rem; }
    .total { font-weight:700; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight:600; border-bottom:0; background:#f8f9fb; font-variant-numeric: tabular-nums; }
    .err { color:var(--bad); font-weight:500; }
    small.err { font-size:.8rem; }
    .actions { display:flex; justify-content:flex-end; margin-top:1.25rem; }
    button { font:inherit; padding:.55rem 1rem; border-radius:6px; cursor:pointer; border:1px solid var(--line); background:#fff; color:inherit; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
    button.ghost { color:var(--muted); }
    button:disabled { opacity:.4; cursor:not-allowed; }
    .result { margin-top:2rem; }
    pre { background:#fff; border:1px solid var(--line); border-radius:8px; padding:1rem; overflow:auto; }
  `],
})
export class AppComponent {
  private fb = inject(FormBuilder);
  private api = inject(TimesheetService);
  readonly days = DAYS;

  userForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
  });

  form = this.fb.group({
    user_id: this.fb.control<number | null>(null, Validators.required),
    period_start: [mondayOfThisWeek(), Validators.required],
    entries: this.fb.array(this.buildWeek(mondayOfThisWeek())),
  });

  users = signal<User[]>([]);
  createdUser = signal<User | null>(null);
  submitted = signal<Timesheet | null>(null);
  saving = signal(false);
  creatingUser = signal(false);
  error = signal<string | null>(null);

  private value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  periodEnd = computed(() => {
    const start = this.value().period_start;
    return start ? addDays(start, 6) : '';
  });

  grandTotal = computed(() =>
    (this.value().entries ?? []).reduce((sum, row) => sum + (+(row?.hours ?? 0) || 0), 0),
  );

  get entries(): FormArray<FormGroup> {
    return this.form.get('entries') as FormArray<FormGroup>;
  }

  constructor() {
    this.form.get('period_start')?.valueChanges.subscribe(start => {
      if (start) this.replaceWeek(start);
    });
    this.refreshUsers();
  }

  private buildWeek(periodStart: string): FormGroup[] {
    return DAYS.map((_, i) =>
      this.fb.group({
        work_date: [addDays(periodStart, i)],
        hours: [0, [Validators.min(0), Validators.max(24)]],
        description: [''],
      }),
    );
  }

  private replaceWeek(periodStart: string) {
    const previous = this.entries.getRawValue() as CreateEntryRequest[];
    this.entries.clear();
    this.buildWeek(periodStart).forEach((row, i) => {
      row.patchValue({
        hours: previous[i]?.hours ?? 0,
        description: previous[i]?.description ?? '',
      });
      this.entries.push(row);
    });
  }

  private refreshUsers(selectId?: number) {
    this.api.listUsers().subscribe({
      next: page => {
        this.users.set(page.items);
        if (selectId != null) this.form.patchValue({ user_id: selectId });
      },
      error: (err: HttpErrorResponse) => this.error.set(apiError(err)),
    });
  }

  show(name: string) {
    const c = this.form.get(name);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  createUser() {
    this.error.set(null);
    this.createdUser.set(null);
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      return;
    }
    this.creatingUser.set(true);
    this.api
      .createUser(this.userForm.getRawValue())
      .pipe(finalize(() => this.creatingUser.set(false)))
      .subscribe({
        next: user => {
          this.createdUser.set(user);
          this.refreshUsers(user.id);
        },
        error: (err: HttpErrorResponse) => this.error.set(apiError(err)),
      });
  }

  submit() {
    this.error.set(null);
    this.submitted.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const payload: SubmitWeekRequest = {
      user_id: raw.user_id!,
      period_start: raw.period_start!,
      period_end: addDays(raw.period_start!, 6),
      entries: (raw.entries as CreateEntryRequest[]).map(e => ({
        work_date: e.work_date,
        hours: +e.hours || 0,
        description: e.description ?? '',
      })),
    };

    this.saving.set(true);
    this.api
      .submitWeek(payload)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: res => this.submitted.set(res),
        error: (err: HttpErrorResponse) => this.error.set(apiError(err)),
      });
  }
}
