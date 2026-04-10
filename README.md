# Career-Ops Full App

This folder is a standalone web migration of the Career-Ops app.
It contains everything needed to run the web stack locally via Docker.

## What is included

- `backend/` – Express API service
- `web/` – simple web frontend
- `worker/` – background worker stub
- `shared/` – shared data loader and sample data
- `infra/docker-compose.yaml` – Docker compose for local development

## How to run

From the `full-app` folder:

```bash
cd full-app/infra
docker compose up --build
```

Then open:

- `http://localhost:3000` — frontend
- `http://localhost:5001/health` — backend health
- `http://localhost:5001/v1/profile` — profile API
- `http://localhost:5001/v1/cv` — CV API

## Customize the data

If your friend wants to use their own profile and CV, edit these files:

- `shared/data/profile.yml`
- `shared/data/cv.md`

## Notes

- This package is designed to work as a standalone zipped folder.
- It does not depend on any files outside `full-app`.
- No additional setup is required other than Docker.
