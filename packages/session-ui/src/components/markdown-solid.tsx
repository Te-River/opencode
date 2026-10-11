import { For, onMount, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic, render } from "solid-js/web"

type MarkdownNode =
  | {
      key: string
      type: "element"
      tag: string
      attributes: Record<string, string>
      children: MarkdownNode[]
      animate?: true
    }
  | { key: string; type: "text"; text: string }
  | { key: string; type: "word"; text: string; animate?: true }

export function createMarkdownRenderer(root: HTMLDivElement, html: string, words: boolean) {
  const [nodes, setNodes] = createStore(parseMarkdownNodes(html, words))
  let ready = false

  const dispose = render(
    () => <For each={nodes}>{(node) => <MarkdownDomNode node={node} animate={() => ready} />}</For>,
    root,
  )

  ready = true

  return {
    update(next: string, nextWords: boolean, animate = true) {
      const parsed = parseMarkdownNodes(next, nextWords, animate)

      // A delta only changes the tail of the block, so most of the parsed tree is identical to what
      // the store already holds. Handing `reconcile` the store's own nodes for those regions keeps it
      // (and `unwrap`) from walking the whole array on every delta.
      setNodes(reconcile(untrack(() => reuseNodes(nodes, parsed)), { key: "key" }))
    },
    dispose,
  }
}

function MarkdownDomNode(props: { node: MarkdownNode; animate: () => boolean }) {
  const node = props.node

  if (node.type === "text") return node.text

  if (node.type === "word") {
    let ref: HTMLSpanElement | undefined
    onMount(() => {
      if (props.animate() && node.animate) ref?.setAttribute("data-markdown-enter", "")
    })

    return (
      <span ref={ref} data-markdown-word="">
        {node.text}
      </span>
    )
  }

  let ref: HTMLElement | undefined
  onMount(() => {
    if (props.animate() && node.animate) ref?.setAttribute("data-markdown-enter", "")
  })

  return (
    <Dynamic component={node.tag} ref={ref} {...node.attributes}>
      <For each={node.children}>{(node) => <MarkdownDomNode node={node} animate={props.animate} />}</For>
    </Dynamic>
  )
}

export function parseMarkdownNodes(html: string, words: boolean, animate = false) {
  const template = document.createElement("template")
  template.innerHTML = html

  return Array.from(template.content.childNodes).flatMap((node, index) => parseNode(node, `${index}`, words, animate))
}

function parseNode(node: Node, key: string, words: boolean, animate: boolean, inlineCode = false): MarkdownNode[] {
  if (node instanceof Text) {
    if (!words) return [{ key, type: "text", text: node.data }]

    return (inlineCode ? Array.from(node.data) : node.data.split(/(\s+)/)).flatMap((text, index): MarkdownNode[] => {
      if (!text) return []

      if (/^\s+$/.test(text)) return [{ key: `${key}:${index}`, type: "text", text }]

      return [{ key: `${key}:${index}`, type: "word", text, ...(animate ? { animate: true as const } : {}) }]
    })
  }

  if (!(node instanceof Element)) return []

  return [
    {
      key,
      type: "element",
      tag: node.tagName.toLowerCase(),
      attributes: Object.fromEntries(Array.from(node.attributes).map((attribute) => [attribute.name, attribute.value])),
      children: Array.from(node.childNodes).flatMap((child, index) =>
        parseNode(
          child,
          `${key}.${index}`,
          words,
          animate,
          inlineCode || (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE"),
        ),
      ),
      ...(words && animate && node.tagName === "CODE" && node.parentElement?.tagName !== "PRE"
        ? { animate: true as const }
        : {}),
    },
  ]
}

function reuseNodes(previous: readonly MarkdownNode[], parsed: readonly MarkdownNode[]): MarkdownNode[] {
  return parsed.map((node, index) => reuseNode(previous[index], node))
}

// A delta only changes the tail of a block, so most of the parsed tree is identical to what the
// store already holds. Keeping the store's own nodes for those regions lets `reconcile` (and the
// `unwrap` it runs first) skip them instead of walking the whole array on every delta.
function reuseNode(previous: MarkdownNode | undefined, node: MarkdownNode): MarkdownNode {
  if (!previous) return node
  if (sameNode(previous, node)) return previous
  if (previous.type !== "element" || node.type !== "element") return node

  return { ...node, children: reuseNodes(previous.children, node.children) }
}

function sameNode(previous: MarkdownNode, node: MarkdownNode): boolean {
  if (previous.key !== node.key || previous.type !== node.type) return false

  if (node.type === "text") return previous.type === "text" && previous.text === node.text

  if (node.type === "word")
    return previous.type === "word" && previous.text === node.text && !!previous.animate === !!node.animate

  if (previous.type !== "element") return false

  return (
    previous.tag === node.tag &&
    !!previous.animate === !!node.animate &&
    sameAttributes(previous.attributes, node.attributes) &&
    previous.children.length === node.children.length &&
    previous.children.every((child, index) => {
      const next = node.children[index]

      return !!next && sameNode(child, next)
    })
  )
}

function sameAttributes(previous: Record<string, string>, next: Record<string, string>) {
  const keys = Object.keys(previous)

  return keys.length === Object.keys(next).length && keys.every((key) => previous[key] === next[key])
}
