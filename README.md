# Ariavora SaaS

Premium creative workspace hosted on GitHub Pages, backed by Supabase Auth, Postgres, Edge Functions, and Stripe.

## AI Video Studio (2026-11-25)

- Website files: `ai-video-studio.css` and `ai-video-studio.js`; section embedded in `index.html`.
- API source: `supabase/functions/generate-video/index.ts`.
- Deployed API: `https://fcgzbebeuywupxkymtdk.supabase.co/functions/v1/generate-video`.
- Model: `alibaba/wan-3.0-prime/text-to-video`, 5-second 720p clips without audio, in 9:16, 16:9, or 1:1.
- User access requires a valid Supabase login and an active LIVE paid subscription in the existing subscription tables.
- A database-side atomic reservation caps each user at 10 submissions per UTC calendar month; clients cannot insert or update the jobs directly.
- Job tracking and output links are in the RLS-protected `public.video_generations` table.
- The `FAL_KEY` environment secret must be configured in **Supabase Dashboard → Edge Functions → Secrets**. Create the key in **fal.ai → Dashboard → API Keys**, then enter it into Supabase directly. Never commit it, paste it in chat, or put it in a browser file.
- The fal OAuth ChatGPT connector does not provide the API key to the deployed website. The website correctly returns an activation notice if the secret is absent.
- We have intentionally not changed Stripe products, prices, webhooks, checkout functions, or existing image/campaign tools.
- Before announcing public launch: add the secret, confirm fal credits, verify a subscribed account can submit one request, test completion and MP4 playback, and validate any storage/expiry policy for generated videos. Also confirm GitHub Pages serves the latest commit.
- Provider usage is billable for submitted requests. The 10-request per-user cap does not constitute an overall business spending cap. Consider an account-side spend limit before opening subscriptions broadly.

## Security notes

Only the browser-safe Supabase URL and publishable key belong in `socialpilot-auth-config.js`. Never commit service-role, Stripe, or fal secret credentials.

