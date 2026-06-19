const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '50kb' }));
app.use(express.static(__dirname));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    next();
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CTF_ADMIN_2026';
const SUBMIT_COOLDOWN_MS = 2000;

// ─── SIMPLE ADMIN RATE LIMITER ────────────────────────────────────────────────
const adminLoginAttempts = {}; // ip -> { count, resetAt }
const ADMIN_MAX_ATTEMPTS = 10;
const ADMIN_WINDOW_MS    = 60 * 1000; // 1 minute window

function adminRateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    if (!adminLoginAttempts[ip] || adminLoginAttempts[ip].resetAt < now) {
        adminLoginAttempts[ip] = { count: 0, resetAt: now + ADMIN_WINDOW_MS };
    }
    adminLoginAttempts[ip].count++;
    if (adminLoginAttempts[ip].count > ADMIN_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Too many admin requests. Try again later.' });
    }
    next();
}

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────────
// users[sessionId] = { name, score, solved: Set<challengeId>, hintsUsed: { [challengeId]: 1|2|3 }, noHintSolves: Set<challengeId>, lastSubmitTime, lastSolveTimestamp }
let users = {};
let leaderBoard = [];
let globalSessionActive = true;
let globalSessionPaused = false;
let disabledCategories = new Set(); // category IDs that are disabled

// ─── CHALLENGE DATA ────────────────────────────────────────────────────────────
// type: 'mc' = multiple choice, 'text' = free text
// answer: always lowercase for comparison
// points: 50 (L1-2), 80 (L3-4), 120 (L5-6), 150 (L7)
// hints: [hint1, hint2, hint3] (progressive)
// hintPenalties: [5, 10, 20] (cumulative deduction per tier used)

const categories = [
  {
    id: 'web',
    title: 'Web Discovery',
    emoji: '🔍',
    description: 'Find hidden information on web pages.',
    color: '#3b82f6',
    challenges: [
      {
        id: 'web_1', level: 1, title: 'First Look',
        question: 'You open a website and see a page full of text. Where would you look if you wanted to find notes that the webpage creator left behind — notes that are invisible to normal visitors?',
        type: 'mc',
        options: ['The page title in the browser tab', 'Hidden comments inside the page code', 'The loading spinner animation', 'The website logo'],
        answer: 'hidden comments inside the page code',
        points: 50,
        hints: [
          'Think about what developers write when they build pages — notes they leave for themselves.',
          'These notes are written with <!-- and --> in the page code, making them invisible on screen.',
          'The answer is: Hidden comments inside the page code. Developers often leave notes in HTML comments!'
        ]
      },
      {
        id: 'web_2', level: 2, title: 'Bottom of the Page',
        question: 'Most visitors only read the top of a webpage. A developer hid a secret message at the very bottom, in tiny grey text. What common name is given to this bottom area of a webpage?',
        type: 'mc',
        options: ['The header', 'The sidebar', 'The footer', 'The navbar'],
        answer: 'the footer',
        points: 50,
        hints: [
          'Think about the structure of a web page: top, middle, and…?',
          'It\'s the opposite of "header". You find copyright info and links there.',
          'The answer is: The footer. Always check the very bottom of a page!'
        ]
      },
      {
        id: 'web_3', level: 3, title: 'The Hidden File',
        question: 'Almost every website has a special file that tells search engines like Google which pages they are NOT allowed to look at. What is the name of this very common file?',
        type: 'mc',
        options: ['secret.txt', 'robots.txt', 'hidden.html', 'admin.php'],
        answer: 'robots.txt',
        points: 80,
        hints: [
          'This file controls what robots (search engine crawlers) are allowed to see.',
          'It is always a plain text file found at the root of a website like: website.com/_____.txt',
          'The answer is: robots.txt. Try visiting any website at /robots.txt to see it!'
        ]
      },
      {
        id: 'web_4', level: 4, title: 'Reverse Code',
        question: 'A page says: "Your secret code is the word CYBER written backwards." What is the secret code?',
        type: 'text',
        answer: 'rebyc',
        points: 80,
        hints: [
          'Take the word CYBER and read each letter from right to left.',
          'C-Y-B-E-R → start from R, then E, then B…',
          'The answer is: REBYC. Reverse the word!'
        ]
      },
      {
        id: 'web_5', level: 5, title: 'URL Clue',
        question: 'A web address (URL) says: https://shop.example.com/deals/flash-sale\n\nWhat is the main domain (the core website name) in this URL?',
        type: 'mc',
        options: ['https', 'shop', 'example.com', 'flash-sale'],
        answer: 'example.com',
        points: 120,
        hints: [
          'The domain is the main part of the URL — not the https://, not the path after the slash.',
          '"shop" is a subdomain (before example.com). The domain itself is the main name.',
          'The answer is: example.com. Subdomains appear before the main domain name!'
        ]
      },
      {
        id: 'web_6', level: 6, title: 'Clue Chain',
        question: 'You find a website that says:\n\n"Page 1: Our username is the name of a planet with rings."\n"Page 2: The password is that planet\'s name + the number of rings (2)."\n\nWhat is the password?',
        type: 'text',
        answer: 'saturn2',
        points: 120,
        hints: [
          'Which planet is famous for its beautiful ring system?',
          'The planet is Saturn. It has a ring system. So: planet name + "2".',
          'The answer is: saturn2. Saturn has a famous ring system!'
        ]
      },
      {
        id: 'web_7', level: 7, title: 'Multi-Step Discovery',
        question: 'A developer left these 3 clues hidden across a page:\n🔵 Clue 1: "First word = color of this dot"\n🟡 Clue 2: "Second word = color of this dot"\n⭐ Clue 3: "Add the number of points on the star"\n\nCombine them: [color1][color2][star points].\nWhat is the final secret code?',
        type: 'text',
        answer: 'blueyellow5',
        points: 150,
        hints: [
          'Read each clue carefully. The first dot is blue, the second is yellow.',
          'A standard 5-pointed star has 5 points. So combine: blue + yellow + 5.',
          'The answer is: blueyellow5. Combine all three clues in order!'
        ]
      }
    ]
  },

  {
    id: 'crypto',
    title: 'Code Breaker',
    emoji: '🔠',
    description: 'Decode secret messages and ciphers.',
    color: '#8b5cf6',
    challenges: [
      {
        id: 'crypto_1', level: 1, title: 'Shift It Back',
        question: 'This message was made by shifting every letter 1 step forward in the alphabet (A→B, B→C...):\n\n"IFMMP"\n\nShift each letter BACK by 1 to decode it. What does it say?',
        type: 'mc',
        options: ['WORLD', 'HELLO', 'CYBER', 'CODES'],
        answer: 'hello',
        points: 50,
        hints: [
          'Take the first letter "I". One step back in the alphabet from I is…?',
          'I→H, F→E, M→L, M→L, P→O. Put them together!',
          'The answer is: HELLO. Each letter shifted back by 1!'
        ]
      },
      {
        id: 'crypto_2', level: 2, title: 'Caesar Cipher',
        question: 'Julius Caesar used a famous code: shift every letter forward by 3.\nA→D, B→E, C→F...\n\nThis message was encoded with Caesar +3:\n"SDVVZRUG"\n\nShift each letter BACK by 3 to decode it.',
        type: 'text',
        answer: 'password',
        points: 50,
        hints: [
          'Take the first letter "S". Count 3 backwards in the alphabet: S → R → Q → P.',
          'S=P, D=A, V=S, V=S... keep going for each letter.',
          'The answer is: PASSWORD. Shift every letter back by 3!'
        ]
      },
      {
        id: 'crypto_3', level: 3, title: 'Emoji Decoder',
        question: 'An agent sent a message using an emoji cipher:\n\n🔑 = K\n⭐ = E\n🔒 = Y\n\nDecode this message: 🔑 ⭐ 🔒\n\nWhat word does it spell?',
        type: 'mc',
        options: ['KOE', 'KEY', 'EYK', 'YEK'],
        answer: 'key',
        points: 80,
        hints: [
          'Just replace each emoji with its letter using the code above.',
          '🔑=K, ⭐=E, 🔒=Y. Put them in order: K, E, Y.',
          'The answer is: KEY. Simple substitution — replace each emoji!'
        ]
      },
      {
        id: 'crypto_4', level: 4, title: 'Reverse Message',
        question: 'A spy sent a message written completely backwards to confuse enemies:\n\n"galf eht dnif"\n\nRead it in reverse to discover the message.',
        type: 'mc',
        options: ['hide the flag', 'find the flag', 'fold the flag', 'keep the flag'],
        answer: 'find the flag',
        points: 80,
        hints: [
          'Try reading the words one by one, but each word is also reversed.',
          '"galf" backwards = "flag". "eht" backwards = "the". "dnif" backwards = ?',
          'The answer is: FIND THE FLAG. Every word is reversed!'
        ]
      },
      {
        id: 'crypto_5', level: 5, title: 'Number Code',
        question: 'If A=1, B=2, C=3... Z=26, decode this number sequence:\n\n3 - 25 - 2 - 5 - 18\n\nWhat word does it spell?',
        type: 'text',
        answer: 'cyber',
        points: 120,
        hints: [
          'Convert each number to its letter: 3=C, 25=?, 2=?, 5=?, 18=?',
          '3=C, 25=Y, 2=B, 5=E, 18=R. Put them all together!',
          'The answer is: CYBER. C(3) Y(25) B(2) E(5) R(18)!'
        ]
      },
      {
        id: 'crypto_6', level: 6, title: 'Base64 Basics',
        question: 'Computers often encode text to share it safely. One common method produces strings with letters, numbers, + and /.\n\nThis encoded text: "aGVsbG8=" means a common greeting in English.\n\nWhat does it decode to?',
        type: 'mc',
        options: ['world', 'hello', 'cyber', 'login'],
        answer: 'hello',
        points: 120,
        hints: [
          'This encoding is called Base64. Online decoders can convert it instantly.',
          '"aGVsbG8=" is a very commonly used example in programming tutorials — it encodes a classic word.',
          'The answer is: hello. "aGVsbG8=" is Base64 for "hello"!'
        ]
      },
      {
        id: 'crypto_7', level: 7, title: 'Double Decode',
        question: 'This message was first shifted forward by 2, THEN reversed:\n\n"QNNGJ"\n\nStep 1: Reverse the message.\nStep 2: Shift each letter BACK by 2.\n\nWhat is the original message?',
        type: 'text',
        answer: 'hello',
        points: 150,
        hints: [
          'Step 1: Reverse "QNNGJ". Read it backwards to get "JGNNQ".',
          'Step 2: Now shift each letter in "JGNNQ" BACK by 2. J→H, G→E, N→L, N→L, Q→O.',
          'The answer is: HELLO. Reversing gives JGNNQ, and shifting back gives HELLO!'
        ]
      }
    ]
  },

  {
    id: 'detective',
    title: 'Digital Detective',
    emoji: '🕵️',
    description: 'Solve OSINT-style clues without leaving this app.',
    color: '#f59e0b',
    challenges: [
      {
        id: 'detective_1', level: 1, title: 'Age Puzzle',
        question: 'A social media profile says:\n"Born in 2000. Currently 24 years old."\n\nBased on this information, what year is it currently?',
        type: 'mc',
        options: ['2023', '2024', '2025', '2026'],
        answer: '2024',
        points: 50,
        hints: [
          'If someone was born in 2000 and is now 24 years old, add 24 to 2000.',
          '2000 + 24 = ?',
          'The answer is: 2024. Born 2000 + age 24 = current year 2024!'
        ]
      },
      {
        id: 'detective_2', level: 2, title: 'Username Clue',
        question: 'An online username is: john_doe_1995\n\nBased on this username alone, what can you make an educated guess about this person?',
        type: 'mc',
        options: ['Their favourite sport', 'The year they were likely born', 'Their country of origin', 'Their job title'],
        answer: 'the year they were likely born',
        points: 50,
        hints: [
          'Many people include personal information in their usernames. What number stands out here?',
          '1995 is a year. People often add their birth year to make unique usernames.',
          'The answer is: The year they were likely born. "1995" at the end is a strong clue!'
        ]
      },
      {
        id: 'detective_3', level: 3, title: 'Same Username Risk',
        question: 'Alex uses the username "alex_hacker99" on Gmail, Instagram, Twitter, and TikTok.\n\nIf one of these platforms gets hacked and Alex\'s username is leaked, what is the main risk?',
        type: 'mc',
        options: ['Slower internet', 'Hackers can link all of Alex\'s accounts together', 'The username gets permanently deleted', 'Alex loses their phone'],
        answer: 'hackers can link all of alex\'s accounts together',
        points: 80,
        hints: [
          'Think about what happens if a hacker knows your username. Can they search for it elsewhere?',
          'If someone finds "alex_hacker99" on one site, they can search for the same name on every other platform.',
          'The answer is: Hackers can link all accounts together. Using one username everywhere creates a trail!'
        ]
      },
      {
        id: 'detective_4', level: 4, title: 'Email Domain',
        question: 'You receive an email from:\nalex.johnson@techcorp.com\n\nWhat is the company\'s domain (website address) based on this email?',
        type: 'text',
        answer: 'techcorp.com',
        points: 80,
        hints: [
          'An email address has two parts: the name (before @) and the domain (after @).',
          'Everything after the @ symbol is the domain name.',
          'The answer is: techcorp.com. The part after @ is always the domain!'
        ]
      },
      {
        id: 'detective_5', level: 5, title: 'Fake Profile',
        question: 'A social media account has:\n• Created today\n• 0 posts\n• 8,000 followers\n• No profile photo\n• Only follows 3 celebrity accounts\n\nIs this likely a real person or a bot/fake account?',
        type: 'mc',
        options: ['Real person — lots of followers means popular', 'Fake/bot account — no activity but huge followers is suspicious', 'Real person — just started today', 'Cannot tell at all'],
        answer: 'fake/bot account — no activity but huge followers is suspicious',
        points: 120,
        hints: [
          'Real accounts usually build followers over time through posts and activity.',
          'A brand new account with thousands of followers and zero posts is a classic bot pattern.',
          'The answer is: Fake/bot account. New + no posts + mass followers = clear bot signal!'
        ]
      },
      {
        id: 'detective_6', level: 6, title: 'Flight Clue',
        question: 'Someone posted on social media:\n"Just landed! 🛬 Flight AF123 was amazing. Paris, here I come! 🗼"\n\nAirline codes: AF = Air France, BA = British Airways, EK = Emirates\n\nWhat airline did they travel with?',
        type: 'mc',
        options: ['British Airways', 'Emirates', 'Air France', 'Lufthansa'],
        answer: 'air france',
        points: 120,
        hints: [
          'The flight number starts with letters — those letters are the airline code.',
          '"AF" at the start of "AF123" is the two-letter IATA code for an airline. Check the list!',
          'The answer is: Air France. "AF" = Air France according to the code list given!'
        ]
      },
      {
        id: 'detective_7', level: 7, title: 'Identity Chain',
        question: 'A mysterious profile contains these clues:\n• Username: "n3ptun3_games"\n• Bio: "Gamer since \'08. From the city of bridges."\n• Post: "My team won 3 championships this year!"\n\nWhich city is associated with "the city of bridges"?',
        type: 'mc',
        options: ['London', 'Venice', 'Pittsburgh', 'Amsterdam'],
        answer: 'pittsburgh',
        points: 150,
        hints: [
          '"City of bridges" is a famous nickname. Multiple cities claim it, but one is most well-known for it in the USA.',
          'Pittsburgh, Pennsylvania is known as "The City of Bridges" with over 440 bridges.',
          'The answer is: Pittsburgh. It is famously nicknamed "The City of Bridges"!'
        ]
      }
    ]
  },

  {
    id: 'password',
    title: 'Password Lab',
    emoji: '🔐',
    description: 'Learn what makes passwords strong or weak.',
    color: '#22c55e',
    challenges: [
      {
        id: 'password_1', level: 1, title: 'Spot the Weakest',
        question: 'Which of these passwords is the WEAKEST and most commonly guessed by hackers?',
        type: 'mc',
        options: ['P@ssw0rd!', 'mydog2020', 'qwerty', '123456'],
        answer: '123456',
        points: 50,
        hints: [
          'Hackers always try the most popular passwords first. Which one here is just a simple number sequence?',
          '"123456" appears on every "Top 10 Worst Passwords" list every single year.',
          'The answer is: 123456. It is the #1 most used (and most hacked) password worldwide!'
        ]
      },
      {
        id: 'password_2', level: 2, title: 'Pick the Stronger',
        question: 'Which of these passwords is STRONGER?',
        type: 'mc',
        options: ['iloveyou', 'abc123', 'mycat', 'Tr0ub4dor!'],
        answer: 'tr0ub4dor!',
        points: 50,
        hints: [
          'A strong password mixes uppercase, lowercase, numbers, and special characters.',
          'Look for the option that has BOTH letters AND numbers AND a special character like ! or @.',
          'The answer is: Tr0ub4dor! — it mixes uppercase, numbers, and a special character!'
        ]
      },
      {
        id: 'password_3', level: 3, title: 'Password Reuse',
        question: 'Sarah uses the same password "summer2020" on her email, banking app, Instagram, and Netflix.\n\nHer Netflix account gets hacked. What is the biggest danger?',
        type: 'mc',
        options: ['Netflix charges extra', 'Hackers can now try the same password on her email and bank', 'Her phone gets a virus', 'Nothing — it is just Netflix'],
        answer: 'hackers can now try the same password on her email and bank',
        points: 80,
        hints: [
          'Think about what the hacker now knows: one password. And where else does Sarah use it?',
          'If one site is hacked, hackers test your stolen password on all other major sites.',
          'The answer: Hackers try it on her email and bank. Password reuse = one breach = all breached!'
        ]
      },
      {
        id: 'password_4', level: 4, title: 'Strong Password Check',
        question: 'Rate this password:\n\n"Xk7!mQ9@pL2#"\n\nIt has: 12 characters, uppercase letters, lowercase letters, numbers, and symbols.\n\nIs this a strong password?',
        type: 'mc',
        options: ['No — it is too confusing', 'No — 12 characters is not enough', 'Yes — it meets all the criteria for a strong password', 'It depends on the website'],
        answer: 'yes — it meets all the criteria for a strong password',
        points: 80,
        hints: [
          'Security experts recommend: 12+ characters AND a mix of character types. Does this qualify?',
          'Length + complexity + variety = strong. "Xk7!mQ9@pL2#" has all four types.',
          'The answer is: Yes. Long + mixed character types = strong password!'
        ]
      },
      {
        id: 'password_5', level: 5, title: 'Dictionary Attack',
        question: 'A "dictionary attack" is when hackers automatically try thousands of common English words as passwords.\n\nWhich password below would SURVIVE a dictionary attack?',
        type: 'mc',
        options: ['sunshine', 'dragon', 'football', 'K9#mPx!2'],
        answer: 'k9#mpx!2',
        points: 120,
        hints: [
          'A dictionary attack tries real words. Which option here is NOT a real word?',
          '"sunshine", "dragon", and "football" are all common words. The last one has no recognizable words.',
          'The answer is: K9#mPx!2. No real words = survives dictionary attacks!'
        ]
      },
      {
        id: 'password_6', level: 6, title: 'What is 2FA?',
        question: 'You log into your bank. It asks for your password, AND then sends a 6-digit code to your phone.\n\nWhat is this security method called?',
        type: 'mc',
        options: ['VPN Protection', 'Two-Factor Authentication (2FA)', 'Password Manager', 'Firewall Login'],
        answer: 'two-factor authentication (2fa)',
        points: 120,
        hints: [
          'This method uses TWO things to verify you: something you know (password) + something you have (phone).',
          'It is abbreviated as "2FA" — two separate steps of authentication.',
          'The answer is: Two-Factor Authentication (2FA). Two steps = much harder to hack!'
        ]
      },
      {
        id: 'password_7', level: 7, title: 'Build a Strong Password',
        question: 'A security expert says: "Take a short sentence you\'ll remember, then make it complex."\n\nExample: "I love coffee at 7am!" → "1L0v3C0ff33@7am!"\n\nUsing the same technique, what would "My cat is 3 years old!" become?\n\nApply: replace vowels with numbers (a=4, e=3, i=1, o=0) and keep the exclamation mark.',
        type: 'text',
        answer: 'my c4t 1s 3 y34rs 0ld!',
        points: 150,
        hints: [
          'Replace: a→4, e→3, i→1, o→0. Keep all other letters, spaces, and punctuation.',
          '"My cat" → "My c4t", "is" → "1s", "years" → "y34rs", "old" → "0ld!"',
          'The answer is: my c4t 1s 3 y34rs 0ld! — Vowels swapped for look-alike numbers!'
        ]
      }
    ]
  },

  {
    id: 'links',
    title: 'Link Hunter',
    emoji: '🌐',
    description: 'Recognize safe and suspicious web links.',
    color: '#06b6d4',
    challenges: [
      {
        id: 'links_1', level: 1, title: 'Spot the Fake',
        question: 'You receive an email with this link:\nhttp://goog1e.com/login\n\nIs this link safe or suspicious?',
        type: 'mc',
        options: ['Safe — it says "google" in it', 'Suspicious — the number 1 replaces the letter "l"', 'Safe — it uses http', 'Cannot tell from the link alone'],
        answer: 'suspicious — the number 1 replaces the letter "l"',
        points: 50,
        hints: [
          'Look very carefully at the spelling. Is "goog1e" the same as "google"?',
          'The letter "l" in google has been replaced with the number "1". This is a trick!',
          'The answer: Suspicious. "goog1e.com" is NOT "google.com" — one character is different!'
        ]
      },
      {
        id: 'links_2', level: 2, title: 'The Padlock',
        question: 'When you visit a website, your browser shows a padlock icon 🔒 next to the web address.\n\nWhat does this padlock mean?',
        type: 'mc',
        options: ['The website is 100% trustworthy', 'Your connection is encrypted (HTTPS)', 'The website is government approved', 'Your antivirus is working'],
        answer: 'your connection is encrypted (https)',
        points: 50,
        hints: [
          'The padlock is about the CONNECTION, not about the website\'s trustworthiness.',
          'HTTPS encrypts your data while travelling between your phone and the server.',
          'The answer: Your connection is encrypted (HTTPS). Note: even scam sites can have HTTPS!'
        ]
      },
      {
        id: 'links_3', level: 3, title: 'Typosquatting',
        question: 'You get an email saying "Your PayPal account needs verification!" with a link to:\npaypa1.com\n\nInstead of:\npaypal.com\n\nWhat type of attack trick is this called?',
        type: 'mc',
        options: ['Phishing', 'Typosquatting', 'Brute Force', 'Malware'],
        answer: 'typosquatting',
        points: 80,
        hints: [
          'The attacker registered a domain that looks like "paypal" but has a typo: "l" replaced by "1".',
          'This technique exploits typing mistakes. The name combines "typo" + "squatting" (sitting on a domain).',
          'The answer is: Typosquatting. Registering misspelled domains to trick users!'
        ]
      },
      {
        id: 'links_4', level: 4, title: 'Short URL Risk',
        question: 'You receive a message with a short link: bit.ly/FR33-PR1ZE\n\nShort URLs hide their real destination. Why might clicking this be risky?',
        type: 'mc',
        options: ['Short URLs are always safe from big companies', 'You cannot know where it actually goes before clicking', 'It will automatically install apps', 'Short URLs expire after 24 hours'],
        answer: 'you cannot know where it actually goes before clicking',
        points: 80,
        hints: [
          'Short URLs are wrappers — they hide the actual destination. The real URL could be anything.',
          'A link promising "FREE PRIZE" + unknown destination = classic phishing setup.',
          'The answer: You cannot know where it leads. Always be cautious with short URLs from strangers!'
        ]
      },
      {
        id: 'links_5', level: 5, title: 'Real Domain Finder',
        question: 'A suspicious email contains this link:\nhttps://secure-login.paypal.com.support-help.xyz/verify\n\nWhat is the ACTUAL domain (the real website owner) of this URL?',
        type: 'mc',
        options: ['paypal.com', 'secure-login.paypal.com', 'support-help.xyz', 'verify'],
        answer: 'support-help.xyz',
        points: 120,
        hints: [
          'The real domain is always the part just before the first single slash (/). Look at what comes BEFORE "/verify".',
          '"secure-login.paypal.com" all looks official but it is actually a subdomain of "support-help.xyz".',
          'The answer is: support-help.xyz. The domain is always the last part before the first slash!'
        ]
      },
      {
        id: 'links_6', level: 6, title: 'QR Code Risk',
        question: 'You see a printed QR code on a poster that says "Scan to win a free iPhone!"\n\nWhat is the SAFEST thing to do before scanning it?',
        type: 'mc',
        options: ['Scan it immediately — free iPhone!', 'Check if the poster looks official, and preview the URL before opening it', 'Only scan if you\'re on WiFi', 'QR codes are always safe'],
        answer: 'check if the poster looks official, and preview the url before opening it',
        points: 120,
        hints: [
          'QR codes can link to anything — malicious websites, fake login pages, or app downloads.',
          'Most phone cameras preview the URL before opening. Always check where it leads first!',
          'The answer: Check the poster and preview the URL. Never blindly open a QR code link!'
        ]
      },
      {
        id: 'links_7', level: 7, title: 'Link Analysis',
        question: 'Analyse this URL carefully:\nhttps://signin.amazon-account-security.support/update-password\n\nWho actually OWNS this website?',
        type: 'mc',
        options: ['Amazon — it says Amazon in the URL', 'amazon-account-security.support — that is the real domain', 'signin — that is the first word', 'update-password — that is the page purpose'],
        answer: 'amazon-account-security.support — that is the real domain',
        points: 150,
        hints: [
          'The domain is always the part between the https:// and the first /. Not what it contains, but the actual registered domain.',
          '"signin" is a subdomain. "amazon-account-security" is part of the main domain. ".support" is the extension.',
          'The answer: amazon-account-security.support. Amazon.com has nothing to do with this site!'
        ]
      }
    ]
  },

  {
    id: 'image',
    title: 'Image Investigation',
    emoji: '🖼️',
    description: 'Spot hidden clues by looking carefully at images.',
    color: '#ec4899',
    challenges: [
      {
        id: 'image_1', level: 1, title: 'Desk Photo Risk',
        question: 'Someone posts a photo of their home office on social media. In the background, a sticky note on their monitor is visible.\n\nWhat sensitive information might a sticky note near a computer contain?',
        type: 'mc',
        options: ['A shopping list', 'A password or login code', 'A phone number for pizza delivery', 'A birthday reminder'],
        answer: 'a password or login code',
        points: 50,
        hints: [
          'People often write things they need to remember quickly near their computer.',
          'Many people write passwords on sticky notes — security experts say this is very dangerous!',
          'The answer: A password or login code. Never write passwords on paper near your screen!'
        ]
      },
      {
        id: 'image_2', level: 2, title: 'Why Blur?',
        question: 'A journalist publishes a news photo and blurs out the license plate of a car.\n\nWhy do they blur the license plate?',
        type: 'mc',
        options: ['To make the photo look artistic', 'To protect the car owner\'s privacy and prevent identification', 'Because license plates are copyrighted', 'To hide that the car is old'],
        answer: 'to protect the car owner\'s privacy and prevent identification',
        points: 50,
        hints: [
          'A license plate can be used to identify and trace who owns a vehicle.',
          'With a plate number, someone could potentially find the owner\'s name and address.',
          'The answer: Protect privacy. License plates link directly to identifiable personal information!'
        ]
      },
      {
        id: 'image_3', level: 3, title: 'Filename Clue',
        question: 'An email attachment is named:\n"Q4_salary_report_final_CONFIDENTIAL.xlsx"\n\nWhat does the filename tell you about this file?',
        type: 'mc',
        options: ['It is a fun spreadsheet game', 'It likely contains sensitive financial and employee data', 'It is a photo album', 'It is a public company announcement'],
        answer: 'it likely contains sensitive financial and employee data',
        points: 80,
        hints: [
          'Read the filename carefully: "salary", "confidential", "Q4 report". What do these words suggest?',
          '"Salary" + "CONFIDENTIAL" = private pay information. "Q4 report" = quarterly business data.',
          'The answer: It contains sensitive financial data. File names reveal a lot about their contents!'
        ]
      },
      {
        id: 'image_4', level: 4, title: 'Background Danger',
        question: 'A new employee posts a selfie on their first day of work, excited to start.\n\nIn the background, their office security badge is clearly visible showing their full name and employee ID number.\n\nWhat is the security risk?',
        type: 'mc',
        options: ['No risk — it is just a name', 'A bad actor could clone the badge or use the info for social engineering', 'Risk is only if they work at a bank', 'Risk only if the badge shows a home address'],
        answer: 'a bad actor could clone the badge or use the info for social engineering',
        points: 80,
        hints: [
          'Employee IDs and names visible in photos can be used to impersonate employees.',
          'Social engineering means tricking people using real-looking information. A visible badge gives attackers real data.',
          'The answer: Badge info can be used for social engineering or cloning. Always hide your work badge in photos!'
        ]
      },
      {
        id: 'image_5', level: 5, title: 'Hidden Text',
        question: 'A screenshot of a chat shows this message with a tiny note at the bottom:\n\n"Meet me at Location X. 🔑 Code: [LOOK AT THE NUMBER OF EMOJIS IN THIS MESSAGE × 10]"\n\nCount the emojis in the instruction sentence. What is the code?',
        type: 'mc',
        options: ['10', '20', '30', '40'],
        answer: '10',
        points: 120,
        hints: [
          'Count the 🔑 emojis in just the instruction part: "🔑 Code: [LOOK AT THE NUMBER OF EMOJIS IN THIS MESSAGE × 10]".',
          'There is only 1 emoji (🔑) in that instruction. 1 × 10 = ?',
          'The answer is: 10. There is 1 emoji, multiplied by 10 = 10!'
        ]
      },
      {
        id: 'image_6', level: 6, title: 'QR Code in Image',
        question: 'You see a photo shared on social media that contains a QR code.\n\nCan a QR code embedded in an image lead to a dangerous website?',
        type: 'mc',
        options: ['No — QR codes in images are always decorative', 'Yes — a QR code always encodes a URL which could be malicious', 'Only if the image is dark coloured', 'Only if you share the image'],
        answer: 'yes — a qr code always encodes a url which could be malicious',
        points: 120,
        hints: [
          'A QR code is just a visual way of storing data (usually a URL). A camera reads it the same way whether it is printed or on screen.',
          'QR codes in images are fully functional and can point to any URL — including dangerous ones.',
          'The answer: Yes. QR codes in images work the same as printed ones — always preview before opening!'
        ]
      },
      {
        id: 'image_7', level: 7, title: 'Reverse Image',
        question: 'A person creates a fake dating profile using someone else\'s photos.\n\nWhat tool or technique can you use to check if a profile photo is genuinely that person, or stolen from someone else online?',
        type: 'mc',
        options: ['Check the photo resolution', 'Run a reverse image search', 'Ask them to wave in a photo', 'Count their followers'],
        answer: 'run a reverse image search',
        points: 150,
        hints: [
          'There is a specific internet tool that lets you upload a photo and find where else it appears online.',
          'Google Images and TinEye are popular tools. You upload the photo → they search the web for it.',
          'The answer: Run a reverse image search. It reveals if a photo appears on other websites or profiles!'
        ]
      }
    ]
  },

  {
    id: 'phishing',
    title: 'Phishing Hunter',
    emoji: '🎣',
    description: 'Detect scams, fake emails, and digital tricks.',
    color: '#ef4444',
    challenges: [
      {
        id: 'phishing_1', level: 1, title: 'Too Good to Be True',
        question: 'You receive this email:\n\n"🎉 CONGRATULATIONS! You\'ve won $1,000,000! Click this link NOW to claim your prize before it expires in 2 hours!"\n\nIs this email safe or a scam?',
        type: 'mc',
        options: ['Safe — the money is real', 'Scam — urgent prize emails are classic phishing', 'Safe — it has an emoji so it is friendly', 'Cannot tell without clicking the link'],
        answer: 'scam — urgent prize emails are classic phishing',
        points: 50,
        hints: [
          'Two major red flags: unexpected huge prize + urgency ("2 hours!"). Real lotteries don\'t email you.',
          '"You\'ve WON!" + "CLICK NOW" + fake deadline = textbook phishing email.',
          'The answer: Scam. Unexpected prize + artificial urgency = phishing! Never click!'
        ]
      },
      {
        id: 'phishing_2', level: 2, title: 'Password Request',
        question: 'An email from "IT Support" says:\n\n"We are upgrading our systems. Please reply with your username and password to avoid losing access."\n\nWhat should you do?',
        type: 'mc',
        options: ['Reply immediately with your password', 'Do not reply — real IT teams never ask for your password', 'Change your password then send the new one', 'Forward the email to friends'],
        answer: 'do not reply — real it teams never ask for your password',
        points: 50,
        hints: [
          'Think: would a real IT department actually need your password? They have admin tools.',
          'Legitimate IT support NEVER needs your personal password. This is a golden rule in cybersecurity.',
          'The answer: Do not reply. Real IT staff never ask for passwords via email — this is a scam!'
        ]
      },
      {
        id: 'phishing_3', level: 3, title: 'SMS Scam',
        question: 'You receive this SMS:\n\n"[BANK ALERT] Your account has been LOCKED due to suspicious activity. Verify immediately by calling 0800-FAKE-NUM or texting your PIN."\n\nWhat is this?',
        type: 'mc',
        options: ['A real bank alert — reply with your PIN', 'A smishing attack (SMS phishing)', 'A regular marketing message', 'A confirmation of a recent transaction'],
        answer: 'a smishing attack (sms phishing)',
        points: 80,
        hints: [
          'Banks NEVER ask for your PIN via SMS. Also notice: urgency + "locked account" = pressure tactics.',
          'SMS phishing has a specific name: "Smishing" (SMS + Phishing).',
          'The answer: Smishing. Banks never text asking for PINs. Delete and block!'
        ]
      },
      {
        id: 'phishing_4', level: 4, title: 'Sender Fake',
        question: 'You get an email:\nFrom: support@arnazon.com\nSubject: "Urgent: Update your Amazon payment info"\n\nWhat is wrong with this email?',
        type: 'mc',
        options: ['Nothing — Amazon always emails about payments', 'The domain is "arnazon.com" not "amazon.com" — it is fake', 'The subject line is too polite', 'Amazon never sends emails'],
        answer: 'the domain is "arnazon.com" not "amazon.com" — it is fake',
        points: 80,
        hints: [
          'Look very carefully at the email address domain: a-r-n-a-z-o-n vs a-m-a-z-o-n.',
          '"arnazon" is NOT "amazon" — the letters M and RN look similar! This is called a homograph attack.',
          'The answer: arnazon.com ≠ amazon.com. Always read email domains character by character!'
        ]
      },
      {
        id: 'phishing_5', level: 5, title: 'True or False',
        question: 'TRUE or FALSE:\n\n"Legitimate companies like banks, Netflix, and Google will sometimes email you asking for your password to verify your account."',
        type: 'mc',
        options: ['True — companies need to verify you', 'False — no legitimate company ever asks for your password', 'True — but only banks do this', 'It depends on the company'],
        answer: 'false — no legitimate company ever asks for your password',
        points: 120,
        hints: [
          'Think about it: why would a company need YOUR password? They control their own systems.',
          'If a company sends you a "verify your password" email, it is always a phishing attempt.',
          'The answer: FALSE. Zero legitimate companies ever need your password via email. This is universal!'
        ]
      },
      {
        id: 'phishing_6', level: 6, title: 'Fake Login Page',
        question: 'You click a link in an email and land on a page that looks EXACTLY like Instagram\'s login page.\n\nBefore you type your password, what should you ALWAYS check first?',
        type: 'mc',
        options: ['Check if the background colour is the same', 'Check the URL in the browser bar — does it say instagram.com?', 'Check if the logo looks right', 'Check the date the page was created'],
        answer: 'check the url in the browser bar — does it say instagram.com?',
        points: 120,
        hints: [
          'Attackers can copy the EXACT visual design of any website. You cannot trust how it looks.',
          'The one thing attackers CANNOT fake is the actual URL in your browser\'s address bar.',
          'The answer: Check the URL. The address bar never lies — visuals can be perfectly copied!'
        ]
      },
      {
        id: 'phishing_7', level: 7, title: 'Red Flag Count',
        question: 'Examine this email carefully:\n\n📧 From: noreply@paypa1-secure.support\n📋 Subject: "!!URGENT!! Account SUSPENDED — verify in 24 hrs or LOSE access FOREVER"\n📝 Body: "Dear Valued Customer, click bellow to verify you\'re account details immediately."\n\nHow many phishing red flags can you spot? (Count: typo in domain, urgency, grammar errors, threats)',
        type: 'mc',
        options: ['1 red flag', '2 red flags', '3 red flags', '4 or more red flags'],
        answer: '4 or more red flags',
        points: 150,
        hints: [
          'Go through each red flag type: domain typo? urgency/threats? grammar mistakes?',
          'Flag 1: "paypa1" not "paypal". Flag 2: URGENT + 24hrs + FOREVER. Flag 3: "bellow" not "below". Flag 4: "you\'re account" not "your account".',
          'The answer: 4 or more red flags. This email has typo domain + fake urgency + multiple grammar errors!'
        ]
      }
    ]
  }
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getChallengeById(challengeId) {
    for (const cat of categories) {
        const ch = cat.challenges.find(c => c.id === challengeId);
        if (ch) return { challenge: ch, category: cat };
    }
    return null;
}

function updateLeaderboard() {
    const newLeaderboard = Object.values(users)
        .sort((a, b) => {
            // Primary: highest score
            if (b.score !== a.score) return b.score - a.score;
            
            // Secondary: fewest hints used
            const aHints = Object.values(a.hintsUsed).reduce((sum, val) => sum + val, 0);
            const bHints = Object.values(b.hintsUsed).reduce((sum, val) => sum + val, 0);
            if (aHints !== bHints) return aHints - bHints;
            
            // Third: earliest completion
            return a.lastSolveTimestamp - b.lastSolveTimestamp;
        })
        .slice(0, 20)
        .map(u => ({
            name: u.name,
            score: u.score,
            solved: u.solved.length,
            sessionId: u.sessionId
        }));

    if (JSON.stringify(newLeaderboard) !== JSON.stringify(leaderBoard)) {
        leaderBoard = newLeaderboard;
        io.emit('leaderboard_update', leaderBoard);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function requireSession(req, res, next) {
    const sessionId = req.headers['sessionid'] || req.body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') return res.status(401).json({ error: 'Missing session' });
    const user = users[sessionId];
    if (!user) return res.status(401).json({ error: 'Unauthorized session' });
    req.user = user;
    req.sessionId = sessionId;
    next();
}

function requireAdmin(req, res, next) {
    adminRateLimit(req, res, () => {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Join
app.post('/join', (req, res) => {
    let { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Invalid name' });
    name = name.trim().substring(0, 32);
    if (!name) return res.status(400).json({ error: 'Invalid name' });

    const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
    if (isDuplicate) return res.status(409).json({ error: 'Name already taken by an active player' });

    const sessionId = crypto.randomUUID();
    users[sessionId] = {
        name,
        sessionId,
        score: 0,
        solved: [],          // array of challengeIds
        hintsUsed: {},       // { [challengeId]: 1 | 2 | 3 } — highest tier used
        noHintSolves: [],    // challengeIds solved without any hint
        lastSubmitTime: 0,
        lastSolveTimestamp: Date.now()
    };

    updateLeaderboard();
    res.json({ success: true, sessionId, name });
});

// All categories with player progress
app.get('/categories', requireSession, (req, res) => {
    const user = req.user;
    const result = categories.map(cat => {
        const totalLevels = cat.challenges.length;
        const solvedLevels = cat.challenges.filter(c => user.solved.includes(c.id)).length;
        return {
            id: cat.id,
            title: cat.title,
            emoji: cat.emoji,
            description: cat.description,
            color: cat.color,
            totalLevels,
            solvedLevels
        };
    });
    res.json(result);
});

// Challenges for one category
app.get('/category/:id', requireSession, (req, res) => {
    const user = req.user;
    const cat = categories.find(c => c.id === req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found' });

    const challenges = cat.challenges.map(c => ({
        id: c.id,
        level: c.level,
        title: c.title,
        points: c.points,
        solved: user.solved.includes(c.id),
        hintUsed: user.hintsUsed[c.id] || 0
    }));

    res.json({
        id: cat.id,
        title: cat.title,
        emoji: cat.emoji,
        color: cat.color,
        challenges
    });
});

// Single challenge detail
app.get('/challenge/:id', requireSession, (req, res) => {
    const user = req.user;
    const found = getChallengeById(req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found' });

    const { challenge: c, category: cat } = found;
    const hintTier = user.hintsUsed[c.id] || 0;
    const revealedHints = c.hints.slice(0, hintTier);

    res.json({
        id: c.id,
        categoryId: cat.id,
        categoryTitle: cat.title,
        level: c.level,
        title: c.title,
        question: c.question,
        type: c.type,
        options: c.options || null,
        points: c.points,
        solved: user.solved.includes(c.id),
        hintTier,
        hints: revealedHints,
        hintPenalties: [5, 10, 20]
    });
});

// Request hint (tier 1, 2, or 3)
app.post('/hint', requireSession, (req, res) => {
    if (!globalSessionActive || globalSessionPaused) return res.status(403).json({ error: 'SESSION_ENDED' });
    const { challengeId, tier } = req.body;
    const user = req.user;
    const found = getChallengeById(challengeId);
    if (!found) return res.status(404).json({ error: 'Challenge not found' });

    const { challenge: c } = found;
    const requestedTier = parseInt(tier) || 1;

    if (requestedTier < 1 || requestedTier > 3) return res.status(400).json({ error: 'Invalid hint tier' });
    if (user.solved.includes(challengeId)) return res.json({ hint: c.hints[requestedTier - 1], tier: requestedTier });

    const currentTier = user.hintsUsed[challengeId] || 0;
    if (requestedTier <= currentTier) {
        // Already revealed — just return, no penalty
        return res.json({ hint: c.hints[requestedTier - 1], tier: requestedTier, alreadyUsed: true });
    }

    // Only deduct for tiers not yet used
    const penalties = [5, 10, 20];
    let totalDeduction = 0;
    for (let t = currentTier + 1; t <= requestedTier; t++) {
        totalDeduction += penalties[t - 1];
    }

    user.hintsUsed[challengeId] = requestedTier;
    user.score -= totalDeduction;
    updateLeaderboard();

    res.json({
        hint: c.hints[requestedTier - 1],
        tier: requestedTier,
        deducted: totalDeduction
    });
});

// Submit answer
app.post('/submit', requireSession, (req, res) => {
    if (!globalSessionActive || globalSessionPaused) return res.status(403).json({ error: 'SESSION_ENDED' });
    const { challengeId, answer } = req.body;
    const user = req.user;

    if (!challengeId || answer === undefined || answer === null || typeof answer !== 'string') {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const now = Date.now();
    if (now - user.lastSubmitTime < SUBMIT_COOLDOWN_MS) {
        return res.status(429).json({ error: 'COOLDOWN_ACTIVE', wait: SUBMIT_COOLDOWN_MS - (now - user.lastSubmitTime) });
    }
    user.lastSubmitTime = now;

    const found = getChallengeById(challengeId);
    if (!found) return res.status(404).json({ error: 'Challenge not found' });

    const { challenge: c, category: cat } = found;

    if (user.solved.includes(challengeId)) {
        return res.status(400).json({ error: 'ALREADY_SOLVED' });
    }

    const isCorrect = answer.trim().toLowerCase() === c.answer.trim().toLowerCase();

    if (isCorrect) {
        user.solved.push(challengeId);
        user.lastSolveTimestamp = now;

        let earnedPoints = c.points;
        const usedHint = !!(user.hintsUsed[challengeId]);

        if (!usedHint) {
            earnedPoints += 10; // No-hint bonus
            user.noHintSolves.push(challengeId);
        }

        user.score += earnedPoints;
        updateLeaderboard();

        io.emit('challenge_solved', {
            name: user.name,
            categoryTitle: cat.title,
            challengeTitle: c.title,
            level: c.level,
            noHint: !usedHint
        });

        // Check if category completed
        const allCatSolved = cat.challenges.every(ch => user.solved.includes(ch.id));

        res.json({
            success: true,
            correct: true,
            points: earnedPoints,
            noHintBonus: !usedHint,
            categoryCompleted: allCatSolved
        });
    } else {
        res.json({ success: true, correct: false });
    }
});

// Leaderboard
app.get('/leaderboard', (req, res) => {
    res.json(leaderBoard);
});

// Overall progress for a player
app.get('/progress', requireSession, (req, res) => {
    const user = req.user;
    const totalChallenges = categories.reduce((sum, cat) => sum + cat.challenges.length, 0);
    res.json({
        score: user.score,
        solved: user.solved.length,
        total: totalChallenges,
        noHintSolves: user.noHintSolves.length
    });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (req, res) => {
    const totalChallenges = categories.reduce((sum, cat) => sum + cat.challenges.length, 0);
    res.json({
        users: Object.values(users).map(u => ({
            sessionId: u.sessionId,
            name: u.name,
            score: u.score,
            solved: u.solved.length,
            hintsUsed: Object.values(u.hintsUsed).reduce((a, b) => a + b, 0),
            lastSolveTimestamp: u.lastSolveTimestamp || null
        })),
        totalChallenges,
        totalSolves: Object.values(users).reduce((acc, u) => acc + u.solved.length, 0),
        sessionActive: globalSessionActive,
        paused: globalSessionPaused,
        leaderboard: leaderBoard,
        categories: categories.map(cat => ({
            id: cat.id,
            title: cat.title,
            levels: cat.challenges.length,
            enabled: !disabledCategories.has(cat.id)
        }))
    });
});

// Reset entire game (legacy route kept)
app.post('/admin/reset', requireAdmin, (req, res) => {
    users = {};
    leaderBoard = [];
    io.emit('leaderboard_update', leaderBoard);
    res.json({ success: true });
});

// Fresh start — wipe everything, restart session
app.post('/admin/fresh-start', requireAdmin, (req, res) => {
    users = {};
    leaderBoard = [];
    globalSessionActive = true;
    globalSessionPaused = false;
    disabledCategories = new Set();
    io.emit('leaderboard_update', leaderBoard);
    io.emit('session_state', { active: true, paused: false });
    res.json({ success: true });
});

// Ban / delete user
app.post('/admin/ban', requireAdmin, (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !users[sessionId]) return res.status(400).json({ error: 'Invalid user' });
    delete users[sessionId];
    updateLeaderboard();
    res.json({ success: true });
});

// Reset individual user progress
app.post('/admin/reset-user', requireAdmin, (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !users[sessionId]) return res.status(400).json({ error: 'Invalid user' });
    const u = users[sessionId];
    u.score = 0;
    u.solved = [];
    u.hintsUsed = {};
    u.noHintSolves = [];
    u.lastSubmitTime = 0;
    u.lastSolveTimestamp = Date.now();
    updateLeaderboard();
    res.json({ success: true });
});

// Rename user
app.post('/admin/rename-user', requireAdmin, (req, res) => {
    const { sessionId, newName } = req.body;
    if (!sessionId || !users[sessionId]) return res.status(400).json({ error: 'Invalid user' });
    if (!newName || typeof newName !== 'string') return res.status(400).json({ error: 'Invalid name' });
    const trimmed = newName.trim().substring(0, 32);
    if (!trimmed) return res.status(400).json({ error: 'Invalid name' });
    const isDuplicate = Object.values(users).some(u => u.sessionId !== sessionId && u.name.toLowerCase() === trimmed.toLowerCase());
    if (isDuplicate) return res.status(409).json({ error: 'Name already taken' });
    users[sessionId].name = trimmed;
    updateLeaderboard();
    res.json({ success: true });
});

// Session control (supports paused state)
app.post('/admin/session', requireAdmin, (req, res) => {
    const { active, paused } = req.body;
    if (typeof active === 'boolean') globalSessionActive = active;
    if (typeof paused === 'boolean') globalSessionPaused = paused;
    io.emit('session_state', { active: globalSessionActive, paused: globalSessionPaused });
    res.json({ success: true, active: globalSessionActive, paused: globalSessionPaused });
});

// Toggle category enabled/disabled
app.post('/admin/category', requireAdmin, (req, res) => {
    const { categoryId, enabled } = req.body;
    if (!categoryId) return res.status(400).json({ error: 'Missing categoryId' });
    if (enabled) disabledCategories.delete(categoryId);
    else disabledCategories.add(categoryId);
    res.json({ success: true });
});

// Export leaderboard
app.get('/admin/export', requireAdmin, (req, res) => {
    const exportData = Object.values(users).map(u => ({
        name: u.name,
        score: u.score,
        solved_count: u.solved.length,
        solved_challenges: u.solved.join(', '),
        hints_used: Object.values(u.hintsUsed).reduce((a, b) => a + b, 0)
    })).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.hints_used - b.hints_used;
    });
    res.json({ success: true, exportData });
});

// Legacy export (POST kept for backward compat)
app.post('/admin/export', requireAdmin, (req, res) => {
    const exportData = Object.values(users).map(u => ({
        name: u.name,
        score: u.score,
        solved_count: u.solved.length,
        solved_challenges: u.solved.join(', '),
        hints_used: Object.values(u.hintsUsed).reduce((a, b) => a + b, 0)
    })).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.hints_used - b.hints_used;
    });
    res.json({ success: true, exportData });
});

// Export participation (includes categories attempted)
app.get('/admin/export/participation', requireAdmin, (req, res) => {
    const exportData = Object.values(users).map(u => {
        const catsAttempted = categories
            .filter(cat => cat.challenges.some(c => u.solved.includes(c.id) || u.hintsUsed[c.id]))
            .map(cat => cat.title);
        return {
            name: u.name,
            score: u.score,
            solved_count: u.solved.length,
            hints_used: Object.values(u.hintsUsed).reduce((a, b) => a + b, 0),
            categories: catsAttempted.join(', ')
        };
    }).sort((a, b) => b.score - a.score);
    res.json({ success: true, exportData });
});

// ─── DEFAULT ROUTES ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Keep old routes working
app.get('/terminal.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'play.html'));
});

// ─── SOCKET ───────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    // Send current state to newly connected client
    socket.emit('leaderboard_update', leaderBoard);
    socket.emit('session_state', { active: globalSessionActive, paused: globalSessionPaused });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const total = categories.reduce((s, c) => s + c.challenges.length, 0);
    console.log(`\n🛡️  CyberQuest Server running on port ${PORT}`);
    console.log(`📚 ${categories.length} categories | ${total} challenges loaded`);
    console.log(`🔑 Admin secret: ${ADMIN_SECRET}\n`);
});
