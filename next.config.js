/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@neondatabase/serverless'],
  },
  images: {
    domains: ['lh3.googleusercontent.com'],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production'
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'"
    // We moved inline styles into globals.css, so style-src can be 'self'.
    const styleSrc = "style-src 'self'"
    // Allow Google avatar images (lh3) and data URIs for avatars
    const imgSrc = "img-src 'self' data: https://lh3.googleusercontent.com https://www.google.com"
    const csp = `default-src 'self'; ${scriptSrc}; ${styleSrc}; ${imgSrc};`

    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: csp,
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig