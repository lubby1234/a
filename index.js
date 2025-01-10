const https = require('https');
const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');
const UserAgent = require('user-agents');

// Constants
const ENC_URL = 'aHR0cHM6Ly90aGV0dmFwcC50bw==';
const BASE_URL = Buffer.from(ENC_URL, 'base64').toString('utf-8');
const HTTP_PROXY = ''; // Set to 'socks5://127.0.0.1:9150' for Tor, or leave as '' if not using a proxy.
const STREAM_URLS_FILE = path.resolve(__dirname, 'event-ids.json');
const DELAY_MS = 10000; // Delay between requests (in milliseconds)
const MAX_RETRIES = 3; // Maximum number of retries for page navigation

// Array to store all stream URLs during the run
let allStreamUrls = [];

// Load existing event IDs from event-ids.json
function loadExistingStreamUrls() {
  if (fs.existsSync(STREAM_URLS_FILE)) {
    try {
      const fileData = fs.readFileSync(STREAM_URLS_FILE);
      return JSON.parse(fileData);
    } catch (error) {
      console.error('Error loading existing stream URLs:', error);
    }
  }
  return [];
}

// Function to save all stream URLs to event-ids.json at the end of the run
function saveAllStreamUrls() {
  if (allStreamUrls.length === 0) {
    console.error('No URLs collected, skipping save.');
    return;
  }
  fs.writeFileSync(STREAM_URLS_FILE, JSON.stringify(allStreamUrls, null, 2));
  console.error('Stream URLs saved.');
}

// Function to collect matched stream IDs in an array during the run
function collectStreamId(eventUrl, streamId) {
  const strippedEventUrl = eventUrl.replace(BASE_URL, '');

  // Check for duplicates before adding
  if (!allStreamUrls.some(entry => entry.eventUrl === strippedEventUrl && entry.streamId === streamId)) {
    allStreamUrls.push({ eventUrl: strippedEventUrl, streamId });
  }
}

// Function to make an HTTPS request to get the HTML content of the page
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Function to extract all event URLs from the page
async function extractEventUrls(html) {
  const regex = /<a\s+class="list-group-item"\s+href="(\/event\/[^"]+)"/g;
  let match;
  const eventUrls = [];

  while ((match = regex.exec(html)) !== null) {
    eventUrls.push(`${BASE_URL}${match[1]}`);
  }

  return eventUrls;
}

// Function to navigate to the event URL with retry logic
async function navigateToEventPage(page, eventUrl, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.error(`Attempt ${attempt}: Navigating to event URL: ${eventUrl}`);
      await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
      return true; // Successful navigation
    } catch (error) {
      console.error(`Error navigating to ${eventUrl}: ${error.message}`);
      if (attempt === retries) {
        console.error(`Failed to navigate to ${eventUrl} after ${retries} attempts.`);
        return false; // Failed after max retries
      }
      console.error(`Retrying navigation (${attempt}/${retries})...`);
    }
  }
  return false;
}

// Main function to handle browsing and collecting stream IDs
(async () => {
  try {
    // Load existing event URLs and stream IDs
    const existingStreamUrls = loadExistingStreamUrls();
    console.error(`Loaded ${existingStreamUrls.length} existing stream URLs.`);

    // Add existing stream URLs to allStreamUrls to include them in the final JSON
    allStreamUrls = [...existingStreamUrls];

    console.error(`Fetching the main page: ${BASE_URL}`);
    const html = await fetchHtml(BASE_URL);
    const eventUrls = await extractEventUrls(html);

    console.error(`Found ${eventUrls.length} event URLs. Starting Playwright...`);

    // Launch the Playwright browser with proxy settings if provided
    const browser = await firefox.launch({
      headless: true,
      proxy: HTTP_PROXY ? { server: HTTP_PROXY } : undefined,
	  args: ['--mute-audio']
    });

    const context = await browser.newContext({
      userAgent: new UserAgent().toString(),
      bypassCSP: true, // Enable bypassing content security policies for interception
    });
    const page = await context.newPage();

    // Enable request interception to block specific domains and collect matching stream URLs
    await page.route('**/*', (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes('google-analytics.com')) {
        console.log(`Blocking request to: ${requestUrl}`);
        route.abort(); // Block the request to google-analytics.com
      } else {
        route.continue(); // Allow other requests to proceed
      }
    });

    // Add the listener for request events to collect stream IDs
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (requestUrl.includes('/hls/') && requestUrl.includes('index.m3u8')) {
        const streamIdMatch = requestUrl.match(/\/hls\/([^/]+)/);
        const streamId = streamIdMatch ? streamIdMatch[1] : null;
        if (streamId) {
          console.error(`Matching stream ID found: ${streamId}`);
          collectStreamId(currentEventUrl, streamId); // Collect unique stream ID
        }
      }
    });

    for (const eventUrl of eventUrls) {
      const strippedEventUrl = eventUrl.replace(BASE_URL, '');

      // Check if the event URL is already in the existing data
      if (existingStreamUrls.some(entry => entry.eventUrl === strippedEventUrl)) {
        console.log(`Skipping event URL: ${eventUrl} (already exists in event-ids.json)`);
        continue; // Skip scraping if event URL already exists
      }

      currentEventUrl = eventUrl; // Set the current event URL for the listener to use
      const navigationSuccess = await navigateToEventPage(page, eventUrl);
      if (!navigationSuccess) continue; // Skip to the next URL if navigation failed

      // Find and click the visible button with the class 'video-button'
      const visibleButton = await page.$('.video-button:not([style*="display: none"])');
      if (visibleButton) {
        await visibleButton.click();
        console.error('Clicked on the visible button with class "video-button".');
      } else {
        console.error('No visible button with class "video-button" found.');
        continue; // Move on to the next event URL
      }

      // Add a delay before the next iteration
      console.log(`Waiting for ${DELAY_MS / 1000} seconds before the next request...`);
      await delay(DELAY_MS);
    }

    await browser.close();
    console.error('Browser closed after completing all requests.');

  } catch (error) {
    console.error('An error occurred:', error);
  }

  // Save all collected stream IDs at the end of the run
  saveAllStreamUrls();
})();

// Delay function to wait for a specified time
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
