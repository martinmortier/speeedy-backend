# Speeedy Backend

Minimal sync backend for [Speeedy](https://speeedy.pages.dev) — stores uploaded EPUB/PDF files and reading positions so you can resume across devices.

## API

All routes (except `/health`) require `Authorization: Bearer <AUTH_TOKEN>`.

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/health`             | Healthcheck                          |
| POST   | `/api/books`          | Upload file (multipart `file`)       |
| GET    | `/api/books`          | List library with progress           |
| GET    | `/api/books/:id`      | Book metadata + position             |
| GET    | `/api/books/:id/file` | Download original file               |
| PATCH  | `/api/books/:id`      | Update position / wpm / title        |
| DELETE | `/api/books/:id`      | Remove book                          |

`id` is `sha256(file)[:24]`.

## Run locally

```
AUTH_TOKEN=devtoken npm start
```

## Env

- `PORT` — default `3000`
- `DATA_DIR` — default `./data`
- `AUTH_TOKEN` — required
