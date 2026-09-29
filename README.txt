Build.vote static site

Files: index.html, roadmap.html, tokenomics.html, whitepaper.html, style.css, app.js
No build step. Keep all six files in the same folder.

Hosting (pick one):
- Vercel: drag the folder into vercel.com/new, or run `npx vercel` inside it.
- Netlify: drag the folder onto app.netlify.com/drop.
- GitHub Pages: push the files to a repo, Settings > Pages > deploy from main branch root.
- Cloudflare Pages: create a project, upload the folder directly.

Wallet signing needs HTTPS (all the hosts above give you that). Opening index.html
straight from disk works for the design, but wallet extensions may not inject on file:// pages.

Point build.vote at the host with the DNS records the host gives you.

Updating the site (name, contract address, buy link, repo):
Open gen.py, edit the five lines at the top (NAME, HANDLE, CA, BUY_URL, GITHUB_URL),
then run `python3 buildvote/gen.py` from the folder that contains buildvote/. It rewrites all five pages.
With CA set, the hero shows the address with a working Copy button and the Token tag reads "live".
With BUY_URL set, the Buy button becomes a live link.
