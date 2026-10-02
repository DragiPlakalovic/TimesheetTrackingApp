import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl, FormArray, FormBuilder, FormControl, FormGroup,
  ReactiveFormsModule, ValidationErrors, Validators,
} from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { finalize, startWith } from 'rxjs';
import { Timesheet, TimesheetResponse, TimesheetService } from './timesheet.service';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

/** Form-level validator: no day may exceed 24 hours across all rows. */
function dailyLimit(group: AbstractControl): ValidationErrors | null {
  const rows = (group.get('entries') as FormArray).getRawValue() as Record<Day, number>[];
  const over = DAYS.filter(d => rows.reduce((sum, r) => sum + (+r[d] || 0), 0) > 24);
  return over.length ? { dailyLimit: over } : null;
}

function mondayOfThisWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReactiveFormsModule, JsonPipe],
  template: `
    <main>
      <h1>Weekly timesheet</h1>

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="meta">
          <label>
            Employee name
            <input formControlName="employee" autocomplete="name" />
            @if (show('employee')) { <small class="err">Enter your name.</small> }
          </label>
          <label>
            Week starting (Monday)
            <input type="date" formControlName="weekStarting" />
            @if (show('weekStarting')) { <small class="err">Choose a date.</small> }
          </label>
        </div>

        <div class="grid" formArrayName="entries">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Task</th>
                @for (d of days; track d) { <th class="num">{{ d }}</th> }
                <th class="num">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (row of entries.controls; track row; let i = $index) {
                <tr [formGroupName]="i">
                  <td>
                    <input formControlName="project" placeholder="Project" aria-label="Project"
                           [class.invalid]="row.get('project')?.touched && row.get('project')?.invalid" />
                  </td>
                  <td><input formControlName="task" placeholder="What you worked on" aria-label="Task" /></td>
                  @for (d of days; track d) {
                    <td class="num">
                      <input type="number" step="0.25" min="0" max="24" [formControlName]="d"
                             [attr.aria-label]="d + ' hours'"
                             [class.invalid]="row.get(d)?.invalid" />
                    </td>
                  }
                  <td class="num total">{{ rowTotals()[i] }}</td>
                  <td>
                    <button type="button" class="ghost" (click)="removeRow(i)"
                            [disabled]="entries.length === 1" aria-label="Remove row">Remove</button>
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td colspan="2">Daily total</td>
                @for (d of days; track d) {
                  <td class="num" [class.over]="dayTotals()[d] > 24">{{ dayTotals()[d] }}</td>
                }
                <td class="num total">{{ grandTotal() }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        @if (form.errors?.['dailyLimit']) {
          <p class="err">A single day can't exceed 24 hours. Check: {{ form.errors?.['dailyLimit'].join(', ') }}.</p>
        }

        <div class="actions">
          <button type="button" class="ghost" (click)="addRow()">Add row</button>
          <button type="submit" class="primary" [disabled]="saving()">
            {{ saving() ? 'Submitting…' : 'Submit timesheet' }}
          </button>
        </div>
      </form>

      @if (error(); as message) {
        <p class="err" role="alert">{{ message }}</p>
      }

      @if (submitted(); as saved) {
        <section class="result">
          <h2>Timesheet submitted (ID {{ saved.id }})</h2>
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
    h2 { font-size: 1.1rem; }
    .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    label { display:flex; flex-direction:column; gap:.25rem; font-weight:600; font-size:.9rem; }
    input { font:inherit; padding:.45rem .55rem; border:1px solid var(--line); border-radius:6px; background:#fff; color:inherit; width:100%; box-sizing:border-box; }
    input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
    input.invalid { border-color: var(--bad); }
    .grid { overflow-x:auto; background:#fff; border:1px solid var(--line); border-radius:8px; }
    table { border-collapse:collapse; width:100%; min-width:860px; }
    th, td { padding:.4rem .5rem; text-align:left; border-bottom:1px solid var(--line); }
    th { font-size:.8rem; color:var(--muted); text-transform:capitalize; font-weight:600; }
    .num { text-align:right; width:64px; }
    td.num input { text-align:right; padding-inline:.3rem; }
    td:nth-child(1) { width:170px; } td:nth-child(2) { min-width:200px; }
    .total { font-weight:700; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight:600; border-bottom:0; background:#f8f9fb; font-variant-numeric: tabular-nums; }
    tfoot .over { color:var(--bad); }
    .err { color:var(--bad); font-weight:500; }
    small.err { font-size:.8rem; }
    .actions { display:flex; justify-content:space-between; margin-top:1.25rem; }
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

  form = this.fb.group(
    {
      employee: ['', [Validators.required, Validators.minLength(2)]],
      weekStarting: [mondayOfThisWeek(), Validators.required],
      entries: this.fb.array([this.newRow()]),
    },
    { validators: dailyLimit },
  );

  submitted = signal<TimesheetResponse | null>(null);
  saving = signal(false);
  error = signal<string | null>(null);

  // Live snapshot of the form so totals recompute on every keystroke.
  private value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  private rows = computed(() => (this.value().entries ?? []) as Partial<Record<Day, number>>[]);

  rowTotals = computed(() => this.rows().map(r => DAYS.reduce((s, d) => s + (+(r[d] ?? 0) || 0), 0)));
  dayTotals = computed(() => {
    const out = {} as Record<Day, number>;
    for (const d of DAYS) out[d] = this.rows().reduce((s, r) => s + (+(r[d] ?? 0) || 0), 0);
    return out;
  });
  grandTotal = computed(() => this.rowTotals().reduce((a, b) => a + b, 0));

  get entries(): FormArray<FormGroup> {
    return this.form.get('entries') as FormArray<FormGroup>;
  }

  private newRow(): FormGroup {
    const hours = () => new FormControl(0, { nonNullable: true, validators: [Validators.min(0), Validators.max(24)] });
    return this.fb.group({
      project: ['', Validators.required],
      task: [''],
      mon: hours(), tue: hours(), wed: hours(), thu: hours(), fri: hours(), sat: hours(), sun: hours(),
    });
  }

  addRow() { this.entries.push(this.newRow()); }
  removeRow(i: number) { if (this.entries.length > 1) this.entries.removeAt(i); }

  show(name: string) {
    const c = this.form.get(name);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  submit() {
    this.error.set(null);
    this.submitted.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const payload: Timesheet = {
      ...(this.form.getRawValue() as Omit<Timesheet, 'totalHours'>),
      totalHours: this.grandTotal(),
    };

    this.saving.set(true);
    this.api
      .submit(payload)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: res => this.submitted.set(res),
        error: (err: HttpErrorResponse) =>
          this.error.set(
            err.status === 0
              ? "Can't reach the server. Check your connection and try again."
              : err.status === 400 || err.status === 422
                ? err.error?.message ?? 'The server rejected this timesheet. Check the entries and try again.'
                : 'Something went wrong while saving. Try again in a moment.',
          ),
      });
  }
}