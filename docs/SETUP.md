# Requirement Inbox — Chrome extension setup

Free to run. The extension talks to Gmail directly from your browser with your own Google sign-in.
There is no server, no subscription and no AI service. Setup takes about 10 minutes, once.

Your extension ID will be **dkjhnblpopcodlcaffdeaajlklljajgo** (fixed by the key in `manifest.json`).

## 1. Load the extension in Chrome

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it into a folder you'll keep (for example `Documents/Requirement-Inbox`).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside it (the one that contains `manifest.json`).
5. Check that the ID under "Requirement Inbox" is `dkjhnblpopcodlcaffdeaajlklljajgo`.
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to Requirement Inbox.

## 2. Create a free Google Cloud project and turn on the Gmail API

No billing account or card is needed.

1. Go to https://console.cloud.google.com/ and sign in with the Gmail account you use for job emails.
2. Top bar → project picker → **New project** → name it `Requirement Inbox` → **Create**, then select it.
3. Go to **APIs & Services → Library**, search **Gmail API**, open it, click **Enable**.

## 3. Set up the sign-in screen (OAuth consent)

1. Go to **APIs & Services → OAuth consent screen** (newer consoles call it **Google Auth Platform**). Click **Get started**.
2. App name: `Requirement Inbox`. User support email: your Gmail. Audience: **External**. Contact email: your Gmail. Finish and **Create**.
3. **Data access → Add or remove scopes**, add these two, then **Update** and **Save**:
   - `https://www.googleapis.com/auth/gmail.readonly` (read requirement emails)
   - `https://www.googleapis.com/auth/gmail.compose` (send replies and save drafts)
4. **Audience → Test users → Add users** → add your Gmail address → **Save**.
5. Recommended, so you don't have to sign in again every 7 days: on **Audience**, click **Publish app** → **Confirm**.
   You do **not** need to submit it for verification; it's only for you. Google will show a
   "Google hasn't verified this app" screen when you sign in. Click **Advanced → Go to Requirement Inbox (unsafe)**.
   It's your own app, so this is expected.

## 4. Create the client ID and paste it into the extension

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Chrome Extension**. Name: `Requirement Inbox`.
3. Item ID: `dkjhnblpopcodlcaffdeaajlklljajgo` → **Create**.
4. Copy the **Client ID** (ends with `.apps.googleusercontent.com`).
5. Open `extension/manifest.json` with any text editor and replace
   `PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com` with your client ID. Save.
6. Back in `chrome://extensions`, click the reload arrow on Requirement Inbox.

## 5. Start using it

1. Click the toolbar icon → **Open dashboard**.
2. Enter your Gmail address → **Sign in with Google and verify** → choose the same account → allow both Gmail permissions.
3. **Fill in your profile** on the screen that follows: name, phone, visa and its expiry, current company and title,
   years of experience, the job titles you want, your skills, and your resume. Your requirements are fetched in the
   background meanwhile. You can change the profile any time on the **Profile** tab.
4. The first fetch reads the last 30 days of requirement emails. After that it checks every hour while Chrome is open
   (change it under **Settings**). A **Requirements** button also appears at the bottom-left of Gmail.

## Updating from an earlier version

1. Open your current `manifest.json` and copy the `client_id` line.
2. Unzip the new version over your extension folder, then paste the `client_id` back into the new `manifest.json`.
3. In `chrome://extensions`, click the reload arrow. Your requirements, templates and resume are kept.
4. Chrome may ask to allow notifications for the extension; allow it to get desktop alerts.

## Optional: better extraction with Gemini (free)

1. Go to https://aistudio.google.com/apikey and click **Create API key** (free, no card).
2. In the dashboard, **Settings → Better extraction with Gemini**, paste the key, click **Test key**, then **Save settings**.
   If Google doesn't offer the chosen model to your key (new keys can't use Gemini 2.5), a newer model is used automatically.
3. From the next fetch, Gemini cleans up role, client, rate, visa rules and skills. Rows it improved show an **AI** tag.
   On the free tier Google may use what's sent to improve its models; leave the key empty if that's a concern.

## Your profile and templates

- **Profile tab:** personal details, visa and expiry, current employment, job titles, skills, preferred setting, and
  resumes. Job titles decide which roles are kept and what is searched on Dice. Skills count as "you have it" in skill
  gaps. Green Card and US Citizen holders never have "USC / GC only" roles filtered out.
- **Templates** can use your profile details: `{my_name}`, `{my_phone}`, `{my_email}`, `{my_visa}`, `{my_visa_until}`,
  `{my_years}`, `{my_company}`, `{my_title}`, `{my_location}`, `{my_availability}`, `{my_rate}`, `{my_linkedin}`,
  `{my_skills}`. A line like "Phone: {my_phone}" is left out when that detail is empty.
- **Attach resume:** each template can attach no resume, the best-matching resume for each role, or a specific resume.
  The **Share resume** template attaches the best match. You can change it for one send in the reply bar's **Attach** box.

## Job boards

After each email fetch, the extension also brings in jobs posted in the last 24 hours (change it under **Settings → Job boards**; job boards send alerts once or twice a day, so a shorter window can miss them):

- **Indeed, ZipRecruiter, Glassdoor and Monster:** it reads the job-alert emails these sites send you and lists each job
  with company, location and pay. Turn on job alerts for your titles on those sites to get more.
- **Startups:** Wellfound, Built In and RemoteHunter job-alert emails, plus Hacker News' monthly "Ask HN: Who is hiring?"
  thread (new posts, through Hacker News' free public search). They show under **Source: Startups**.
- **Dice:** every 3 hours it searches Dice for the first few job titles in your profile.
- **Recruiter emails in postings:** when a Dice job or a Hacker News post lists a recruiter's email (and phone), it's shown
  on the row and you can select the row and send a template to that recruiter, with your resume attached. Use the
  **Apply to a posting** template. Replies and follow-ups are then tracked like any recruiter email.

Everything is listed newest first.

They show under **Source: Job boards** and **Dice**, filtered by your profile. You apply on each site with **Apply on …**,
then **Mark applied**. **Check job boards now** runs it right away, and the line under the Source buttons shows what the last check read: how many alert emails, how many jobs were new, filtered out or already listed.

## Dice

The extension never logs in to Dice for you or applies on its own. It works alongside your normal Dice use:

1. **Set your profile** in the dashboard under **Settings → Match my profile**: the job titles you want
   (software engineer titles are filled in), the most years a role can ask for (5, plus 1 year of leeway), and whether to skip
   Principal, Staff, Architect, Manager and Director titles. This filter applies to recruiter emails and Dice jobs alike.
2. **Get Dice jobs every hour:** click **Search Dice for my profile** in the dashboard. On the Dice results page, click
   **Create job alert** and choose daily. Each hour the extension reads those alert emails from Gmail, opens each job,
   and keeps only the ones that match your profile.
3. **While you browse Dice**, job results you look at are checked and saved automatically, and every job page shows a
   small Requirement Inbox panel: whether it matches your profile, visa fit, years asked, and skill gaps against your resume.
4. **Applying:** apply on Dice as usual. When you click Dice's Apply button the job is marked **Applied** in the dashboard,
   so the duplicate guard warns if a recruiter later emails you the same role. Use **Mark applied** in the panel if you
   applied another way.
5. **Dice confirmation emails:** when Dice emails you "Application for … at … sent", the extension marks that job
   **Applied** (or adds it as Applied if it wasn't in the dashboard), so recruiters emailing you the same role are flagged.

## Everyday use

- **Reply in bulk:** tick requirements (or "Select all"), pick a template, then **Send replies** (you confirm first) or **Save as drafts**. Each reply goes in the recruiter's own email thread.
  Each reply goes only to that recruiter, inside the same email thread.
- **Track:** counters for fetched, awaiting reply, replied, in drafts and recruiter replied. The **Reply log** tab lists the time of every send.
- **Filters:** clearance roles, USC/GC-only roles and job-board junk are left out automatically. They stay under
  **Filtered out** so you can restore any. Quick filters: received in the last 1, 3 or 7 days, OPT accepted, W2 only,
  local, and your minimum rate (set your cities and rate in **Settings**).
- **Recruiter replies:** when a recruiter answers, you get a desktop alert and it appears under **Replies & interviews**.
  Nothing is sent automatically. **Draft reply** saves a reply in Gmail drafts, with your best-matching resume attached.
- **Interviews:** invites are spotted in replies, with a one-click **Add to Google Calendar**.
- **Follow-ups:** recruiters who haven't answered in 3 days (you can change this) show under **Follow-ups**; select and send.
- **Duplicate guard:** when several vendors send the same role, the list says so, and warns if you already replied or
  submitted through another vendor. Use **Mark submitted** after you send your resume so the guard knows.
- **Vendors:** reply rate, response time and repeat emails per vendor. **Mute** sends a vendor's emails to Filtered out.
- **Reports:** requirements and replies per week, your reply rate and the most requested skills.
- **Resumes:** add several versions. **Show skills** picks the best match for each role and highlights the gaps.

## Troubleshooting

| What you see | Fix |
| --- | --- |
| "The extension's Google client ID isn't set up yet" | Step 4: paste the client ID into `manifest.json`, then reload the extension. |
| "The Gmail API isn't enabled" | Step 2.3. |
| Sign-in window says "Access blocked" or "app not verified" with no way forward | Add yourself as a test user (step 3.4). |
| You signed in as a different account | Chrome uses the Google account Chrome itself is signed into. Sign Chrome into your job-search Gmail (profile icon, top right) or use a Chrome profile for it. |
| Asked to sign in again after a week | Publish the app (step 3.5). |
| Fetching stopped | The timer only runs while Chrome is open. Click **Fetch now** after reopening; it catches up on the last few days. |

## Privacy

- Mail is read straight from Google into this extension. Nothing is sent to any other server.
- The extension stores the requirement details, reply log, templates and your resume in Chrome on this computer only.
- **Settings → Remove all fetched data** clears them. Removing the extension deletes everything.
- To revoke access at any time: https://myaccount.google.com/permissions
