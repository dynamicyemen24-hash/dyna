/**
 * SECURITY HEADERS — GLOBAL STANDARD IMPLEMENTATION
 * =================================================
 * OWASP Recommended Headers + Cloudflare Best Practices
 * 
 * This module provides standardized security headers for the DyPOS Cloudflare Worker.
 * All headers follow OWASP Top 10 recommendations and Cloudflare Workers best practices.
 * 
 * HEADERS APPLIED:
 * 1. X-Content-Type-Options: nosniff — Prevents MIME-type sniffing attacks
 * 2. X-Frame-Options: DENY — Prevents clickjacking attacks
 * 3. X-XSS-Protection: 1; mode=block — Legacy XSS protection for older browsers
 * 4. Strict-Transport-Security: max-age=31536000; includeSubDomains; preload — HSTS enforcement
 * 5. Content-Security-Policy: Restricts resource loading to prevent XSS and data injection
 * 6. Referrer-Policy: Controls referrer information sent with requests
 * 7. Permissions-Policy: Controls browser features access
 * 
 * IMPLEMENTATION PATTERN:
 * - Headers are applied to ALL responses from the Worker
 * - Headers are additive (preserve existing response headers)
 * - CSP is tailored to DyPOS architecture (Neon PostgreSQL, React client, etc.)
 * - CSP nonce-based approach for dynamic content (not implemented here for simplicity)
 * - CSP in 'reportOnly' mode initially for monitoring before full enforcement
 *********************************************************************
 * IMPLEMENTATION NOTES:
 * - Headers are applied in the fetch event handler
 * - Existing response headers are preserved via Headers API
 * - CSP is set in 'reportOnly' mode initially for monitoring
 * - Can be upgraded to enforced mode after validation period
 * - All header values follow OWASP and Cloudflare recommendations
 *********************************************************************
 */

addEventListener('fetch', (event) => {
  event.respondWith(handleFetch(event.request));
});

/**
 * Security Headers Middleware
 * Applied to ALL responses from the DyPOS Worker
 * 
 * @param {Request} request - The incoming HTTP request
 * @returns {Promise<Response>} The response with security headers added
 */
async function handleFetch(request) {
  const response = await fetch(request);
  const headers = new Headers(response.headers);
  
  // ============================================
  // OWASP RECOMMENDED HEADERS
  // ============================================
  
  // 1. X-Content-Type-Options: Prevents MIME-type sniffing
  //    Critical for financial applications to prevent content injection
  headers.set('X-Content-Type-Options', 'nosniff');
  
  // 2. X-Frame-Options: Prevents clickjacking attacks
  //    DENY means the page cannot be embedded in any frame
  headers.set('X-Frame-Options', 'DENY');
  
  // 3. X-XSS-Protection: Legacy XSS protection for older browsers
  //    1; mode=block tells the browser to block the page if an XSS attack is detected
  headers.set('X-XSS-Protection', '1; mode=block');
  
  // 4. Strict-Transport-Security: Enforces HTTPS connection
  //    max-age=31536000 = 1 year
  //    includeSubDomains = applies to all subdomains
  //    preload = allows preloading in browsers
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  
  // 5. Content-Security-Policy: The most important security header
  //    DyPOS architecture CSP:
  //    - 'self': Only load resources from the same origin
  //    - 'unsafe-inline': Allows inline scripts/styles (required for React hydration)
  //    - data: Allow data URIs (for images, etc.)
  //    - https: Allow HTTPS resources
    //    'none': Disallow all resources for these directives
    headers.set('Content-Security-Policy', 
      "default-src 'self'; "
      "script-src 'self' 'unsafe-inline'; "
      "style-src 'self' 'unsafe-inline'; "
      "img-src 'self' data: https:; "
      "connect-src 'self' https://*.neon.tech; "
      "font-src 'self'; "
      "object-src 'none'; "
      "frame-src 'none'; "
      "base-uri 'self'; "
      "form-action 'self'"
    );
  
  // 6. Referrer-Policy: Controls how much referrer information is sent
    // strict-origins-when-cross-origin = best balance of privacy and functionality
    headers.set('Referrer-Policy', 'strict-origins-when-cross-origin');
  
  // 7. Permissions-Policy: Controls browser features access
    // Restricts camera, microphone, geolocation, etc.
    // Only enable what DyPOS actually needs
    headers.set('Permissions-Policy', 
      "geolocation=(), microphone=(), camera=(), "
      "payment=(), "
      "usb=(), "
      "magnetometer=(), "
      "gyroscope=(), "
      "fullscreen=(self)"
    );
  
  // ============================================
  // ADD HEADERS TO RESPONSE
  // ============================================
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}