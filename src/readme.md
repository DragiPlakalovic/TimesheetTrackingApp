Timesheet Application: A prototype

Some required background information:
Needed tools:
Node.js
SQLite
Python

Necessary libraries:
Angular (Node.js)
Flask (Python)
Flask (SQLAlchemy) (Python)

Database schema: See the attached document

Timesheet application allows contractors to view, edit, and submit timesheets
Timesheet uses calendar weeks for periods. There are five days, Monday to Friday
Frontend is using Angular ReactForms to gather input and validate it.

Front-end and back-end communicate using REST API.
The front-end sends requests in JSON format and using HTTP protocols
The back-end responds using HTTP responses. When receiving a request, back-end will
query the database, get the data and send it back to the front-end