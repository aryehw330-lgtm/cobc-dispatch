# COBC Dispatch — Dev Notes

## Git / GitHub
- SSH is configured on this Mac — `git push` works without passwords or tokens
- Remote: `git@github.com:aryehw330-lgtm/cobc-dispatch.git`
- Hosted on GitHub Pages: https://aryehw330-lgtm.github.io/cobc-dispatch/

## Firebase
- Project: `cobc-dispatch`
- Auth authorized domains: `aryehw330-lgtm.github.io` + `localhost`
- Firestore members collection: document ID = unit number (e.g. `BC-38`)
- Google login requires `email` field on the member's Firestore doc

## Push Notifications
- FCM tokens stored in Google Sheet "COBC FCM TOKENS"
- Apps Script backend handles token registration + FCM sends
- iOS requires PWA (Add to Home Screen) + iOS 16.4+
- System banners only show when app is backgrounded on iOS — in-app toast covers foreground
- Test button on iOS now prompts user to go to Home Screen before notification arrives

## Shared Keys
- PUSH_SHARED_KEY: `cobc-2026-shared-secret` (must match Apps Script)
