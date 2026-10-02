"""Flask REST API for a timesheet system (users, timesheets, daily timesheet entries).

Run:
    python app.py

Use another database by setting DATABASE_URL, e.g.:
    export DATABASE_URL="postgresql+psycopg2://user:pass@localhost:5432/mydb"
"""
import os
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

from flask import Flask, jsonify, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///timesheets.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)


@event.listens_for(Engine, "connect")
def _enable_sqlite_fk(dbapi_conn, _):
    """SQLite ignores foreign keys unless this pragma is set."""
    if dbapi_conn.__class__.__module__.startswith("sqlite3"):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


def utcnow():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- Models
class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(255), nullable=False, unique=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    timesheets = db.relationship("Timesheet", back_populates="user", cascade="all, delete-orphan")

    def to_dict(self):
        return {"id": self.id, "name": self.name, "email": self.email,
                "created_at": self.created_at.isoformat()}


class Timesheet(db.Model):
    """One timesheet per user per period (e.g. a week)."""
    __tablename__ = "timesheets"
    __table_args__ = (
        db.UniqueConstraint("user_id", "period_start", name="uq_timesheet_user_period"),
        db.CheckConstraint("period_end >= period_start", name="ck_timesheet_period"),
    )

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    period_start = db.Column(db.Date, nullable=False)
    period_end = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), nullable=False, default="draft")  # draft|submitted|approved
    submitted_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="timesheets")
    entries = db.relationship("DailyTimesheetEntry", back_populates="timesheet",
                              cascade="all, delete-orphan", order_by="DailyTimesheetEntry.work_date")

    @property
    def total_hours(self):
        return float(sum((e.hours for e in self.entries), Decimal(0)))

    def to_dict(self, include_entries=False):
        data = {
            "id": self.id, "user_id": self.user_id,
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "status": self.status,
            "submitted_at": self.submitted_at.isoformat() if self.submitted_at else None,
            "total_hours": self.total_hours,
            "created_at": self.created_at.isoformat(),
        }
        if include_entries:
            data["entries"] = [e.to_dict() for e in self.entries]
        return data


class DailyTimesheetEntry(db.Model):
    """Hours worked on a single day within a timesheet."""
    __tablename__ = "daily_timesheet_entries"
    __table_args__ = (
        db.UniqueConstraint("timesheet_id", "work_date", name="uq_entry_timesheet_day"),
        db.CheckConstraint("hours >= 0 AND hours <= 24", name="ck_entry_hours"),
    )

    id = db.Column(db.Integer, primary_key=True)
    timesheet_id = db.Column(db.Integer, db.ForeignKey("timesheets.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    work_date = db.Column(db.Date, nullable=False)
    hours = db.Column(db.Numeric(4, 2), nullable=False)
    description = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    timesheet = db.relationship("Timesheet", back_populates="entries")

    def to_dict(self):
        return {"id": self.id, "timesheet_id": self.timesheet_id,
                "work_date": self.work_date.isoformat(), "hours": float(self.hours),
                "description": self.description}


with app.app_context():
    db.create_all()


# ------------------------------------------------------------ Validation
class ValidationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object")
    return data


def parse_date(data, field, required=True):
    if field not in data:
        if required:
            raise ValidationError(f"'{field}' is required (YYYY-MM-DD)")
        return None
    try:
        return date.fromisoformat(str(data[field]))
    except ValueError:
        raise ValidationError(f"'{field}' must be a date in YYYY-MM-DD format")


def parse_hours(value):
    try:
        hours = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValidationError("'hours' must be a number")
    if not Decimal(0) <= hours <= Decimal(24):
        raise ValidationError("'hours' must be between 0 and 24")
    return hours


def parse_str(data, field, max_len, required=True):
    if field not in data:
        if required:
            raise ValidationError(f"'{field}' is required")
        return None
    value = data[field]
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValidationError(f"'{field}' must be a non-empty string")
    if len(value) > max_len:
        raise ValidationError(f"'{field}' must be {max_len} characters or fewer")
    return value.strip()


def require_draft(ts):
    if ts.status != "draft":
        raise ValidationError(f"Timesheet is '{ts.status}' and can no longer be edited", 409)


def check_in_period(ts, work_date):
    if not ts.period_start <= work_date <= ts.period_end:
        raise ValidationError(
            f"'work_date' must be within the timesheet period "
            f"({ts.period_start} to {ts.period_end})")


def paginate(query, to_dict):
    page = request.args.get("page", 1, type=int)
    per_page = min(request.args.get("per_page", 20, type=int), 100)
    p = query.paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({"items": [to_dict(i) for i in p.items], "page": p.page,
                    "per_page": p.per_page, "total": p.total})


# ----------------------------------------------------------------- Users
@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/users")
def list_users():
    return paginate(User.query.order_by(User.id), User.to_dict)


@app.get("/users/<int:user_id>")
def get_user(user_id):
    return jsonify(db.get_or_404(User, user_id).to_dict())


@app.post("/users")
def create_user():
    data = json_body()
    email = parse_str(data, "email", 255).lower()
    if "@" not in email:
        raise ValidationError("'email' must be a valid email address")
    user = User(name=parse_str(data, "name", 100), email=email)
    db.session.add(user)
    db.session.commit()
    return jsonify(user.to_dict()), 201


@app.patch("/users/<int:user_id>")
def update_user(user_id):
    user, data = db.get_or_404(User, user_id), json_body()
    if "name" in data:
        user.name = parse_str(data, "name", 100)
    if "email" in data:
        email = parse_str(data, "email", 255).lower()
        if "@" not in email:
            raise ValidationError("'email' must be a valid email address")
        user.email = email
    db.session.commit()
    return jsonify(user.to_dict())


@app.delete("/users/<int:user_id>")
def delete_user(user_id):
    db.session.delete(db.get_or_404(User, user_id))
    db.session.commit()
    return "", 204


# ------------------------------------------------------------ Timesheets
@app.get("/timesheets")
def list_timesheets():
    q = Timesheet.query.order_by(Timesheet.period_start.desc())
    if request.args.get("user_id", type=int):
        q = q.filter_by(user_id=request.args.get("user_id", type=int))
    if request.args.get("status"):
        q = q.filter_by(status=request.args["status"])
    return paginate(q, Timesheet.to_dict)


@app.get("/users/<int:user_id>/timesheets")
def list_user_timesheets(user_id):
    db.get_or_404(User, user_id)
    q = Timesheet.query.filter_by(user_id=user_id).order_by(Timesheet.period_start.desc())
    return paginate(q, Timesheet.to_dict)


@app.get("/timesheets/<int:ts_id>")
def get_timesheet(ts_id):
    """Returns the timesheet with all of its daily entries."""
    return jsonify(db.get_or_404(Timesheet, ts_id).to_dict(include_entries=True))


@app.post("/timesheets")
def create_timesheet():
    data = json_body()
    user_id = data.get("user_id")
    if not isinstance(user_id, int) or not db.session.get(User, user_id):
        raise ValidationError("'user_id' must reference an existing user", 400)
    start, end = parse_date(data, "period_start"), parse_date(data, "period_end")
    if end < start:
        raise ValidationError("'period_end' must not be before 'period_start'")
    ts = Timesheet(user_id=user_id, period_start=start, period_end=end)
    db.session.add(ts)
    db.session.commit()
    return jsonify(ts.to_dict(include_entries=True)), 201


@app.patch("/timesheets/<int:ts_id>")
def update_timesheet(ts_id):
    ts, data = db.get_or_404(Timesheet, ts_id), json_body()
    require_draft(ts)
    start = parse_date(data, "period_start", required=False) or ts.period_start
    end = parse_date(data, "period_end", required=False) or ts.period_end
    if end < start:
        raise ValidationError("'period_end' must not be before 'period_start'")
    if any(not start <= e.work_date <= end for e in ts.entries):
        raise ValidationError("Existing entries fall outside the new period", 409)
    ts.period_start, ts.period_end = start, end
    db.session.commit()
    return jsonify(ts.to_dict(include_entries=True))


@app.delete("/timesheets/<int:ts_id>")
def delete_timesheet(ts_id):
    db.session.delete(db.get_or_404(Timesheet, ts_id))
    db.session.commit()
    return "", 204


# Workflow: draft -> submitted -> approved; a submitted sheet can be reopened.
TRANSITIONS = {
    "submit": ("draft", "submitted"),
    "approve": ("submitted", "approved"),
    "reopen": ("submitted", "draft"),
}


@app.post("/timesheets/<int:ts_id>/<action>")
def transition_timesheet(ts_id, action):
    if action not in TRANSITIONS:
        raise ValidationError(f"Unknown action '{action}'", 404)
    ts = db.get_or_404(Timesheet, ts_id)
    required, new_status = TRANSITIONS[action]
    if ts.status != required:
        raise ValidationError(f"Cannot {action} a timesheet that is '{ts.status}'", 409)
    ts.status = new_status
    ts.submitted_at = utcnow() if action == "submit" else (
        None if action == "reopen" else ts.submitted_at)
    db.session.commit()
    return jsonify(ts.to_dict())


# --------------------------------------------------- Daily timesheet entries
@app.get("/timesheets/<int:ts_id>/entries")
def list_entries(ts_id):
    ts = db.get_or_404(Timesheet, ts_id)
    return jsonify([e.to_dict() for e in ts.entries])


@app.post("/timesheets/<int:ts_id>/entries")
def create_entry(ts_id):
    ts, data = db.get_or_404(Timesheet, ts_id), json_body()
    require_draft(ts)
    work_date = parse_date(data, "work_date")
    check_in_period(ts, work_date)
    if "hours" not in data:
        raise ValidationError("'hours' is required")
    entry = DailyTimesheetEntry(
        timesheet_id=ts.id, work_date=work_date, hours=parse_hours(data["hours"]),
        description=parse_str(data, "description", 5000, required=False) or "")
    db.session.add(entry)
    db.session.commit()
    return jsonify(entry.to_dict()), 201


@app.get("/entries/<int:entry_id>")
def get_entry(entry_id):
    return jsonify(db.get_or_404(DailyTimesheetEntry, entry_id).to_dict())


@app.patch("/entries/<int:entry_id>")
def update_entry(entry_id):
    entry, data = db.get_or_404(DailyTimesheetEntry, entry_id), json_body()
    require_draft(entry.timesheet)
    if "work_date" in data:
        work_date = parse_date(data, "work_date")
        check_in_period(entry.timesheet, work_date)
        entry.work_date = work_date
    if "hours" in data:
        entry.hours = parse_hours(data["hours"])
    if "description" in data:
        entry.description = parse_str(data, "description", 5000, required=False)
    db.session.commit()
    return jsonify(entry.to_dict())


@app.delete("/entries/<int:entry_id>")
def delete_entry(entry_id):
    entry = db.get_or_404(DailyTimesheetEntry, entry_id)
    require_draft(entry.timesheet)
    db.session.delete(entry)
    db.session.commit()
    return "", 204


# -------------------------------------------------------- Error handlers
@app.errorhandler(ValidationError)
def handle_validation(exc):
    return jsonify({"error": str(exc)}), exc.status


@app.errorhandler(IntegrityError)
def handle_integrity(exc):
    db.session.rollback()
    return jsonify({"error": "Conflict: duplicate record or invalid reference"}), 409


@app.errorhandler(SQLAlchemyError)
def handle_db(exc):
    db.session.rollback()
    app.logger.exception("Database error: %s", exc)
    return jsonify({"error": "Database error"}), 500


@app.errorhandler(404)
def handle_404(_):
    return jsonify({"error": "Resource not found"}), 404


@app.errorhandler(405)
def handle_405(_):
    return jsonify({"error": "Method not allowed"}), 405


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=5000)
