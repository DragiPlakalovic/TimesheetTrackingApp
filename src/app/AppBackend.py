"""Minimal REST server example (Flask, in-memory storage).
 
Install:  pip install flask
Run:      python simple_rest_server.py
"""
 
from flask import Flask, jsonify, request, abort
 
app = Flask(__name__)
 
books = {1: {"id": 1, "title": "Dune", "author": "Frank Herbert"}}
next_id = 2
 
 
@app.get("/books")
def list_books():
    return jsonify(list(books.values()))
 
 
@app.get("/books/<int:book_id>")
def get_book(book_id):
    book = books.get(book_id) or abort(404, "Book not found")
    return jsonify(book)
 
 
@app.post("/books")
def create_book():
    global next_id
    data = request.get_json(silent=True) or {}
    if "title" not in data or "author" not in data:
        abort(400, "title and author are required")
    book = {"id": next_id, "title": data["title"], "author": data["author"]}
    books[next_id] = book
    next_id += 1
    return jsonify(book), 201
 
 
@app.put("/books/<int:book_id>")
def update_book(book_id):
    book = books.get(book_id) or abort(404, "Book not found")
    data = request.get_json(silent=True) or {}
    book.update({k: data[k] for k in ("title", "author") if k in data})
    return jsonify(book)
 
 
@app.delete("/books/<int:book_id>")
def delete_book(book_id):
    if books.pop(book_id, None) is None:
        abort(404, "Book not found")
    return "", 204
 
 
@app.errorhandler(400)
@app.errorhandler(404)
def handle_error(err):
    return jsonify(error=err.description), err.code
 
 
if __name__ == "__main__":
    app.run(debug=True, port=5000)