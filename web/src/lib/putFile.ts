/** Resolves an upload URL to include the base path when running in dev behind a proxy. */
export function resolveUploadUrl(url: string): string {
  if (url.startsWith('/api/')) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
    return `${base}${url}`
  }
  return url
}

/** PUT a file to a presigned URL with XHR so upload progress (0..1) can be reported. */
export function putFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  const targetUrl = resolveUploadUrl(url)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', targetUrl)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again'))
    xhr.send(file)
  })
}
