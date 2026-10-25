/** An HTTP401 is already terminal. A malformed or stalled reason body must
 * not keep a source alive while determining its setup message. */
export async function responseWasReplaced(response: Response): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.json()).then(body => body?.error?.code === "overlay_token_replaced"),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
