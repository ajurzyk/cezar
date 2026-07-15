import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

/**
 * An image that enlarges to a full-screen lightbox on click (#image-zoom). Used for conversation
 * images — the agent's own screenshots and the user's attachments — so a thumbnail can be read
 * without leaving the thread. Dismiss by clicking the backdrop or pressing Escape. The overlay is
 * portalled to <body> so it escapes the thread's overflow/scroll containers.
 */
export function ZoomableImage({
  src,
  alt = '',
  className,
  ...rest
}: {
  src: string
  alt?: string
  className?: string
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'className' | 'onClick'>) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <img
        {...rest}
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setOpen(true)}
        className={cn('cursor-zoom-in', className)}
      />
      {open
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Image preview"
              data-slot="image-lightbox"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            >
              <img
                src={src}
                alt={alt}
                className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
              />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
