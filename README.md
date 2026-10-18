# @rymi/web

Browser SDK for Rymi voice agents over WebRTC.

```bash
npm install @rymi/web
```

## Quick start

Generate a publishable key for your agent in the dashboard or through the [keys API](https://docs.rymi.live/api/keys). Then connect from the browser:

```typescript
import { Rymi } from '@rymi/web';

async function startCall() {
  const call = Rymi.createCall({
    publishableKey: 'sb_publishable_...'
  });

  call.on('started', () => {
    console.log('Connected. Speak now.');
  });

  call.on('transcript', ({ role, text }) => {
    console.log(`${role}: ${text}`);
  });

  call.on('ended', ({ reason }) => {
    console.log('Call ended:', reason);
  });

  await call.connect();
}
```

Full reference: https://docs.rymi.live/api/sdk-web
