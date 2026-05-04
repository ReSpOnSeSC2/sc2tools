# @sc2tools/web — cloud frontend

Next.js 15 App Router + Clerk + Tailwind, deployed on Vercel.

## Local dev

```bash
cd apps/web
npm install
cp .env.example .env.local
# Fill NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, NEXT_PUBLIC_API_BASE
npm run dev
# http://localhost:3000
```

## Routes

| Path                | Auth   | What                                   |
| ------------------- | ------ | -------------------------------------- |
| /                   | public | Landing                                |
| /sign-in, /sign-up  | public | Clerk's hosted UI                      |
| /download           | public | Agent install instructions             |
| /app                | clerk  | Analyzer (opponents tab + sync status) |
| /devices            | clerk  | Pair / list / revoke agents             |
| /streaming          | clerk  | Overlay tokens                         |
| /builds             | clerk  | User's custom-build library            |
| /overlay/[token]    | token  | Public OBS Browser Source target       |

## Deploy

Push to GitHub. In Vercel: New Project → import this repo → set root
directory to `apps/web` → fill the env vars from `.env.example`.
Production target = `https://<your-domain>`. Add the same domain to
Clerk's allowed origins. See
[`docs/cloud/SETUP_CLOUD.md`](../../docs/cloud/SETUP_CLOUD.md).
