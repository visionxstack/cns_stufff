document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const pwInput = document.getElementById('password-input');
    const toggleBtn = document.getElementById('toggle-visibility');
    const eyeIcon = document.getElementById('eye-icon');
    
    const strengthText = document.getElementById('strength-text');
    const entropyText = document.getElementById('entropy-text');
    const meterFill = document.getElementById('meter-fill');
    
    // Stats Elements
    const statLength = document.getElementById('stat-length');
    const statUpper = document.getElementById('stat-upper');
    const statLower = document.getElementById('stat-lower');
    const statDigits = document.getElementById('stat-digits');
    const statSymbols = document.getElementById('stat-symbols');
    const statPool = document.getElementById('stat-pool');
    
    // Time Elements
    const timeOnlineThrottle = document.getElementById('time-online-throttle');
    const timeOnlineUnthrottle = document.getElementById('time-online-unthrottle');
    const timeOfflineSlow = document.getElementById('time-offline-slow');
    const timeOfflineFast = document.getElementById('time-offline-fast');
    
    // Feedback Elements
    const feedbackSection = document.getElementById('feedback-section');
    const warningBox = document.getElementById('warning-box');
    const suggestionsList = document.getElementById('suggestions-list');

    // Strength mappings (using zxcvbn score 0-4)
    const STRENGTH_LABELS = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
    const STRENGTH_COLORS = [
        'var(--strength-0)', 
        'var(--strength-1)', 
        'var(--strength-2)', 
        'var(--strength-3)', 
        'var(--strength-4)',
        '#059669' // Very Strong +
    ];

    // Toggle Password Visibility
    toggleBtn.addEventListener('click', () => {
        const type = pwInput.getAttribute('type') === 'password' ? 'text' : 'password';
        pwInput.setAttribute('type', type);
        eyeIcon.className = type === 'password' ? 'ph ph-eye icon-right' : 'ph ph-eye-slash icon-right';
    });

    // Update Analysis on input
    pwInput.addEventListener('input', (e) => {
        const pwd = e.target.value;
        if (pwd.length === 0) {
            resetUI();
            return;
        }
        analyzePassword(pwd);
    });

    function resetUI() {
        strengthText.textContent = 'Awaiting Password';
        strengthText.style.color = 'var(--text-primary)';
        entropyText.textContent = '0 bits of entropy';
        meterFill.style.width = '0%';
        meterFill.style.backgroundColor = 'transparent';
        
        statLength.textContent = '0';
        statUpper.textContent = '0';
        statLower.textContent = '0';
        statDigits.textContent = '0';
        statSymbols.textContent = '0';
        statPool.textContent = '0';

        timeOnlineThrottle.textContent = 'Instant';
        timeOnlineUnthrottle.textContent = 'Instant';
        timeOfflineSlow.textContent = 'Instant';
        timeOfflineFast.textContent = 'Instant';

        feedbackSection.style.display = 'none';
        warningBox.style.display = 'none';
        suggestionsList.innerHTML = '';
        
        pwInput.style.borderColor = 'transparent';
        pwInput.style.boxShadow = 'none';
    }

    function calculateCharacterStats(pwd) {
        let upper = 0, lower = 0, digits = 0, symbols = 0;
        let poolSize = 0;

        for (let char of pwd) {
            if (/[A-Z]/.test(char)) upper++;
            else if (/[a-z]/.test(char)) lower++;
            else if (/[0-9]/.test(char)) digits++;
            else symbols++;
        }

        if (lower > 0) poolSize += 26;
        if (upper > 0) poolSize += 26;
        if (digits > 0) poolSize += 10;
        if (symbols > 0) poolSize += 33;

        // Custom Entropy calculation logic (simplistic max bits based on pool)
        // zxcvbn provides exact 'entropy' natively
        let entropy = poolSize > 0 ? pwd.length * Math.log2(poolSize) : 0;

        return {
            length: pwd.length,
            upper,
            lower,
            digits,
            symbols,
            poolSize,
            entropy: Math.round(entropy)
        };
    }

    function formatTime(seconds) {
        if (seconds < 1) return 'Instant';
        
        const MINUTE = 60;
        const HOUR = MINUTE * 60;
        const DAY = HOUR * 24;
        const YEAR = DAY * 365;
        const CENTURY = YEAR * 100;
        
        if (seconds < MINUTE) return `${Math.round(seconds)} seconds`;
        if (seconds < HOUR) return `${Math.round(seconds / MINUTE)} mins`;
        if (seconds < DAY) return `${Math.round(seconds / HOUR)} hours`;
        if (seconds < DAY * 30) return `${Math.round(seconds / DAY)} days`;
        if (seconds < YEAR) return `${Math.round(seconds / (DAY * 30))} months`;
        if (seconds < CENTURY) return `${Math.round(seconds / YEAR)} years`;
        if (seconds < CENTURY * 10) return `${Math.round(seconds / CENTURY)} centuries`;
        if (seconds < YEAR * 1e6) return `${Math.round(seconds / YEAR).toLocaleString()} years`;
        if (seconds < YEAR * 1e9) return `${Math.round(seconds / (YEAR * 1e6)).toLocaleString()} million yrs`;
        
        return `${Math.round(seconds / (YEAR * 1e9)).toLocaleString()} billion yrs`;
    }

    function analyzePassword(pwd) {
        // Run zxcvbn analysis (requires zxcvbn to be loaded from CDN)
        if (typeof zxcvbn === 'undefined') {
            console.error('zxcvbn library not loaded');
            return;
        }

        const result = zxcvbn(pwd);
        const stats = calculateCharacterStats(pwd);
        
        // 1. Update UI Stats
        statLength.textContent = stats.length;
        statUpper.textContent = stats.upper;
        statLower.textContent = stats.lower;
        statDigits.textContent = stats.digits;
        statSymbols.textContent = stats.symbols;
        statPool.textContent = stats.poolSize;

        // Uses true entropy from zxcvbn based on pattern guessing, not just math pool
        const bits = Math.round(Math.log2(result.guesses));
        entropyText.textContent = `~${bits} bits of entropy`;

        // 2. Update Strength Meter
        // Zxcvbn maps to 0-4. Modify based on extra length to reward very strong passwords
        let ratingLevel = result.score;
        if (ratingLevel === 4 && stats.length >= 16 && stats.entropy >= 80) {
            ratingLevel = 5; // Extra very strong
        }

        strengthText.textContent = STRENGTH_LABELS[ratingLevel];
        strengthText.style.color = STRENGTH_COLORS[ratingLevel];
        
        const percentage = Math.max(5, (ratingLevel + 1) * 20); // 20% per score chunk
        meterFill.style.width = `${percentage}%`;
        meterFill.style.backgroundColor = STRENGTH_COLORS[ratingLevel];

        // Glow input field
        const wrapper = document.querySelector('.input-wrapper');
        pwInput.style.color = 'white';
        // Subtle outline glow
        // Do not conflict with focus-within by keeping it subtle or altering variable
        
        // 3. Update Crack Times
        // Zxcvbn provides: 100/hr (throttled), 10/s (unthrottled), 10k/s (slow hash), 10B/s (fast hash)
        const times = result.crack_times_seconds;
        timeOnlineThrottle.textContent = formatTime(times.online_throttling_100_per_hour);
        timeOnlineUnthrottle.textContent = formatTime(times.online_no_throttling_10_per_second);
        timeOfflineSlow.textContent = formatTime(times.offline_slow_hashing_1e4_per_second);
        timeOfflineFast.textContent = formatTime(times.offline_fast_hashing_1e10_per_second);

        // 4. Update Feedback
        const warnings = result.feedback.warning;
        const suggestions = result.feedback.suggestions;
        
        // Add custom static suggestions based on stats if not already provided
        let allSuggestions = [...suggestions];
        
        if (stats.length < 16) {
            allSuggestions.push("Increase password length to at least 16 characters for significantly more security.");
        }
        if (stats.poolSize < 50 && stats.length > 5) {
            allSuggestions.push("Use a wider variety of characters (mix upper, lower, numbers, symbols) to increase entropy pool.");
        }
        if (!allSuggestions.some(s => s.toLowerCase().includes("passphrase")) && stats.length < 20) {
            allSuggestions.push("Consider using a memorable multi-word passphrase instead of a complex but short password.");
        }

        // De-duplicate
        allSuggestions = [...new Set(allSuggestions)];

        if (warnings || allSuggestions.length > 0) {
            feedbackSection.style.display = 'block';
            
            if (warnings) {
                warningBox.style.display = 'block';
                warningBox.textContent = `⚠️ Warning: ${warnings}`;
            } else {
                warningBox.style.display = 'none';
            }

            suggestionsList.innerHTML = '';
            allSuggestions.forEach(sug => {
                const li = document.createElement('li');
                li.textContent = sug;
                suggestionsList.appendChild(li);
            });
        } else {
            feedbackSection.style.display = 'none';
        }
    }
});
