#!/bin/bash
# COBC Dispatch — GitHub SSH Setup (fully automatic)

echo "=== Step 1: Generating SSH key ==="
if [ ! -f ~/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -C "cobc-dispatch" -f ~/.ssh/id_ed25519 -N ""
  echo "✅ Key generated"
else
  echo "✅ Key already exists"
fi

# Write public key to a readable file
cp ~/.ssh/id_ed25519.pub ~/Desktop/cobc-dispatch/github-pubkey.txt
cat ~/.ssh/id_ed25519.pub | pbcopy
echo ""
echo "✅ Public key copied to clipboard and saved to:"
echo "   ~/Desktop/cobc-dispatch/github-pubkey.txt"
echo ""
echo "=== Step 2: Opening GitHub SSH settings in browser ==="
open "https://github.com/settings/ssh/new"
echo "✅ Browser opened — paste the key there and click Add SSH key"
echo ""
echo "=== Waiting 60 seconds for you to add the key to GitHub... ==="
echo "(You can see the key in github-pubkey.txt on your Desktop)"

for i in $(seq 60 -1 1); do
  echo -ne "\r⏳ Continuing in $i seconds...   "
  sleep 1
done
echo ""
echo ""

echo "=== Step 3: Pushing to GitHub via SSH ==="
cd ~/Desktop/cobc-dispatch
git remote set-url origin git@github.com:aryehw330-lgtm/cobc-dispatch.git
git add index.html firebase-messaging-sw.js
git commit -m "Push UX: foreground notification routing + iOS test button guidance" 2>/dev/null || true
ssh -o StrictHostKeyChecking=no git@github.com 2>&1 | grep -q "successfully authenticated" && echo "✅ SSH auth OK" || echo "⚠️  SSH auth check done"
git push && echo "" && echo "✅ All done! Changes are live on GitHub." || echo "❌ Push failed — key may not have been added yet. Run this script again."
echo ""
echo "This window will close in 10 seconds..."
sleep 10
