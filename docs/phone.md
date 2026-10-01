# Phone mode

Open bench_bot on a phone (Android or iPhone) that is on the **same Wi-Fi** as your Mac.
Phone mode is **off** unless you switch it on.

## Switch it on

1. In `.env` add:

   ```
   BENCH_PHONE=1
   # optional, at least 8 characters; otherwise a new random password at every start
   BENCH_PHONE_PASSWORD=choose-a-good-one
   ```

2. Start bench_bot as usual (`pnpm dev:desktop` or `pnpm build && pnpm start`).
   macOS may ask whether to allow incoming network connections — answer **Allow**.
3. On the Mac, click **Phone** at the top of the bot list. It shows a **QR code**, the address
   and the password.
4. Scan the QR code with the phone camera. It opens bench_bot and logs in directly.
   Or open the address (e.g. `http://192.168.1.20:8787/`) in Chrome and type the password.

In phone mode bench_bot always uses port **8787** (or `BENCH_PORT`), so the address stays the
same. `pnpm dev` (live-reloading UI) is not reachable from a phone; use `pnpm start` or the app.

## On the phone

Bot list → tap a bot → the chat fills the screen. Use **‹ Bots** to go back, the chat picker to
switch chats, **+** for a new chat. On a phone, Enter makes a new line; tap **Send** to send.

## Security

- Only devices on **private home networks** (192.168.x.x, 10.x.x.x, 172.16–31.x.x) can connect,
  and only to the Mac's own address. Everything else is refused.
- Every phone request needs a login: the password (or the QR code, which contains it). After
  logging in the phone gets a session cookie (HttpOnly, SameSite=Strict). Sessions end when
  bench_bot restarts.
- After 10 wrong passwords an address must wait 10 minutes.
- The engine tool bridge and the Phone panel (which shows the password) stay **Mac-only**.
- **Not encrypted:** traffic on your Wi-Fi is plain `http`. Someone already inside your Wi-Fi
  could read along. Use phone mode on a home network you trust, not on public Wi-Fi.
- Not reachable from outside your home. That would need a VPN such as Tailscale; not built yet.
- A random password changes at every start, so an old QR code stops working.

Code: `apps/api/src/phone.ts` (rules), the gate at the top of `apps/api/src/app.ts`, tests in
`apps/api/src/phone.test.ts` and `apps/api/src/phone-access.test.ts`.

Tested: login, QR link, refusals and the phone layout (Pixel 7 screen size in Chromium). Not yet
tested with a real phone on a real home network.
