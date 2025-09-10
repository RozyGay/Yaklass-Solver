console.log('YaKlass Resolver Background Script Started')

const DEFAULT_CONFIG = {
  apiUrl: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "ur-key-openrouter",
  model: "deepseek/deepseek-chat-v3.1:free",
  siteUrl: "https://yaklass-resolver.com",
  siteName: "YaKlass Resolver"
}

let OPENROUTER_CONFIG = { ...DEFAULT_CONFIG }

async function initializeConfig() {
  try {
    const result = await chrome.storage.sync.get(['openrouter_config'])
    if (result.openrouter_config) {
      OPENROUTER_CONFIG = { ...DEFAULT_CONFIG, ...result.openrouter_config }
      console.log('Configuration loaded from storage')
    }
  } catch (e) {
    console.warn('Failed to load config from storage:', e.message)
  }
}

const SYSTEM_PROMPT = `Ты — ИИ, который помогает решать задания. Проанализируй HTML и текст задания и верни JSON объект с ответами в теге <answer>.

**ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:**
1.  **Используй ключ "mode"** для определения типа ответа. НЕ используй "type".
2.  Для каждого поля для ввода ответа должен быть один объект в массиве "items".
3.  **ВСЕГДА предоставляй сам ответ** в ключах "value", "choice", "choices", "order" и т.д. Не присылай только тип поля.

**ФОРМАТЫ ОТВЕТОВ:**

*   **Для нескольких полей (используй этот формат в большинстве случаев):**
    \`\`\`json
{
  "items": [
        { "mode": "text", "value": "ответ", "target": { "label": "текст вопроса" } },
        { "mode": "single", "choice": "выбранный вариант", "target": { "id": "id-радиокнопки" } },
        { "mode": "multi", "choices": ["вариант1", "вариант2"] }
      ]
    }
    \`\`\`

*   **Для одного поля:**
    \`\`\`json
    { "mode": "text", "value": "ответ для одного поля" }
    \`\`\`

**КЛЮЧИ ДЛЯ ОТВЕТОВ:**
-   mode: "text", "number", "single", "multi", "select", "order".
-   value: для текстовых/числовых полей.
-   choice / choiceId: для одиночного выбора (радиокнопки).
-   choices / choicesId: для множественного выбора (чекбоксы).
-   select / selectValue: для выпадающих списков.
-   order / orderIds: для заданий на порядок.
-   target: (опционально) для точного указания поля через "id", "name", или "label".

Твой ответ должен быть СТРОГО в формате JSON внутри тега <answer>.`

async function initialize() {
  await initializeConfig()
  console.log('YaKlass Resolver initialized with OpenRouter API')
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SOLVE_TASK') {
    solveTask()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ status: 'error', message: error.message || String(error) }))
    return true
  }
})

async function solveTask() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

    await showNotification(tab.id, 'Собираю данные…', 'info')

  const [{ result: task }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectTaskData
  })

  console.log('Task data:', task)

  if (!task || !task.success) {
    console.error('Task collection failed:', task)
    throw new Error(task?.error || 'Не удалось извлечь задание')
  }

    await showNotification(tab.id, 'Решаю…', 'info')

  let rawAnswer = await callAI(buildPrompt(task, 'full'), 38000)

  if (!rawAnswer) {
    await showNotification(tab.id, 'Повтор 1/2…', 'info')
    rawAnswer = await callAI(buildPrompt(task, 'compact'), 26000)
  }

  if (!rawAnswer) {
    await showNotification(tab.id, 'Повтор 2/2…', 'info')
    rawAnswer = await callAI(buildPrompt(task, 'minimal'), 18000)
  }

  if (!rawAnswer) {
    throw new Error('Истекло время ожидания ответа от AI')
  }

  console.log('Raw AI answer:', rawAnswer)
  const parsedAnswer = coerceAnswerForTask(task, parseAnswer(rawAnswer))
  console.log('Final parsed answer:', parsedAnswer)

  if (!parsedAnswer) {
    console.log('Parsed answer is null, trying emergency mode...')
    parsedAnswer = { mode: 'text', value: 'TEST_VALUE_FROM_AI' }
  }

    await showNotification(tab.id, 'Вставляю ответ…', 'info')

  const [{ result: applied }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: applyAnswer,
    args: [parsedAnswer]
  })

  console.log('Applied result:', applied)
  console.log('Parsed answer:', parsedAnswer)

  if (!applied || !applied.success) {
    console.error('Apply failed:', applied)
    throw new Error(applied?.error || 'Не удалось применить ответ')
  }

    await showNotification(tab.id, 'Готово! Проверьте перед отправкой.', 'success')

    return {
      status: 'success',
      message: applied.mode ? `Вставлено: ${applied.mode}` : 'Готово'
    }

  } catch (error) {
    console.error('Solve task error:', error)
    throw error
  }
}

async function callAI(userContent, timeoutMs = 25000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(OPENROUTER_CONFIG.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${OPENROUTER_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': OPENROUTER_CONFIG.siteUrl,
        'X-Title': OPENROUTER_CONFIG.siteName
      },
      body: JSON.stringify({
        model: OPENROUTER_CONFIG.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        temperature: 0.05,
        max_tokens: 1000
      })
    })

    clearTimeout(timeout)

    if (!response.ok) {
      let errorMessage = 'OpenRouter API Error'
      try {
        const errorData = await response.json()
        errorMessage = errorData?.error?.message || errorMessage
      } catch (e) {}
      throw new Error(errorMessage)
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content || ''
    const answerMatch = /<answer>([\s\S]*?)<\/answer>/i.exec(content)

    return answerMatch ? answerMatch[1].trim() : content.trim()

  } catch (error) {
    clearTimeout(timeout)
    if (error.name === 'AbortError') {
      console.warn('AI call timed out')
      return null
    }
    console.error('OpenRouter API call failed:', error.message)
    return null
  }
}

function buildPrompt(task, mode) {
  const limits = {
    full: { txt: 12000, html: 12000, map: 16000, img: 12 },
    compact: { txt: 8000, html: 6000, map: 9000, img: 8 },
    minimal: { txt: 5000, html: 2000, map: 5500, img: 4 }
  }

  const L = limits[mode] || limits.full

  const text = (task.text || '').slice(0, L.txt)
  const html = (task.html || '').slice(0, L.html)
  const images = task.images.slice(0, L.img)

  const payload = {
    hasDnd: task.dnd?.fields > 0,
    text: text,
    htmlSnippet: html,
    images: images,
    dnd: {
      fields: task.dnd.fields,
      options: task.dnd.options.map(o => ({ id: o.id, text: o.text }))
    },
    choices: task.choices.map(c => ({ id: c.id, text: c.text, group: c.group })),
    selects: task.selects.map(s => ({
      id: s.id,
      name: s.name,
      options: s.options.map(o => ({ value: o.value, text: o.text }))
    })),
    inputs: task.inputs.map(i => ({ id: i.id, name: i.name, label: i.label, type: i.type }))
  }

  const dataMap = JSON.stringify(payload).slice(0, L.map)

  return `ДАННЫЕ:\n\`\`\`json\n${dataMap}\n\`\`\`\n\nЕсли есть .gxs-dnd-field — используй mode:"order". Для одного слота — массив из одного текста или orderIds из одного id. Если полей несколько — формат B с items[]. Верни единый JSON в <answer>.`
}

async function showNotification(tabId, message, style = 'info') {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_NOTIFICATION',
      message: message,
      style: style
    })
  } catch (e) {
    console.warn('Failed to show notification:', e.message)
  }
}

function parseAnswer(content) {
  try {
    const json = JSON.parse(content)
    return json && typeof json === 'object' ? json : null
  } catch (e) {
    const trimmed = (content || '').trim()
    if (!trimmed) return null

    if (trimmed.includes('\n')) {
      return {
        mode: 'order',
        order: trimmed.split('\n').map(x => x.trim()).filter(Boolean)
      }
    }

    return { mode: 'text', value: trimmed }
  }
}

function coerceAnswerForTask(task, answer) {
  try {
    if (!answer) return null;
    console.log('Coercing answer (original):', JSON.parse(JSON.stringify(answer)));

    const normalize = obj => {
      if (Array.isArray(obj)) return obj.map(normalize);
      if (obj && typeof obj === 'object') {
        if ('type' in obj) {
          obj.mode = obj.type;
          delete obj.type;
        }
        for (const key in obj) {
          normalize(obj[key]);
        }
      }
      return obj;
    };
    
    const normalizedAnswer = normalize(JSON.parse(JSON.stringify(answer)));
    
    if (normalizedAnswer && normalizedAnswer.mode && !normalizedAnswer.items) {
      return { items: [normalizedAnswer] };
    }
    
    console.log('Coerced answer (final):', normalizedAnswer);
    return normalizedAnswer;
  } catch (e) {
    console.error('Error coercing answer:', e);
    return answer;
  }
}

function collectTaskData() {
  function normalizeText(text) {
    return (text || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2000-\u200F\u2028\u202F\u2060\uFEFF]/g, '')
      .toLowerCase()
      .replace(/[\u2212\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function absolutizeUrl(url) {
    try {
      if (!url) return url
      const a = document.createElement('a')
      a.href = url
      return a.href
    } catch (e) {
      return url
    }
  }

  const root = document.querySelector('#taskhtml,.taskhtmlwrapper,.task-content,.exercise-content,.yak-exercise__task')
  if (!root) {
    console.log('Available elements:', document.querySelectorAll('*').length)
    console.log('Body content preview:', document.body?.innerText?.slice(0, 200))
    return { success: false, error: 'root not found' }
  }
  console.log('Root found:', root.tagName, root.className)
  console.log('Page URL:', window.location.href)
  console.log('Page title:', document.title)

  const clone = root.cloneNode(true)
  clone.querySelectorAll('script,style,svg,button').forEach(el => el.remove())

  const text = clone.innerText.trim().replace(/\s\s+/g, ' ')
  let html = clone.innerHTML || ''
  html = html
    .replace(/ data-[\w-]+="[^"]*"/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const inputs = []
  const inputSelectors = [
    'input[type="text"]',
    'input[type="number"]', 
    'input.gxs-answer-number',
    'textarea',
    '[contenteditable="true"]',
    'input[name*="|tb"]',
    'input.form-control',
    'input.answer-input',
    '.answer-field input',
    '.gxs-answer input'
  ]
  
  console.log('Searching for inputs with selectors:', inputSelectors)
  
  inputSelectors.forEach(selector => {
    const elements = root.querySelectorAll(selector)
    console.log(`Found ${elements.length} elements with selector: ${selector}`)
    elements.forEach(el => {
      const id = el.id || ''
      const name = el.name || ''
      const className = el.className || ''
      let label = ''

      const labelById = id ? root.querySelector(`label[for="${id}"]`) : null
      if (labelById) label = labelById.innerText.trim()

      if (!label) {
        const parentLabel = el.closest('label')
        if (parentLabel) label = parentLabel.innerText.trim()
      }

      inputs.push({
        type: (el.type === 'number' ? 'number' :
               (el.tagName === 'TEXTAREA' ? 'text' :
               (el.contentEditable === 'true' ? 'text' : 'text'))),
        id,
        name,
        className,
        label,
        placeholder: el.placeholder || '',
        selector: selector
      })
    })
  })
  
  console.log('Total inputs found:', inputs.length, inputs)

  const choices = []
  root.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(el => {
    const id = el.id || ''
    const group = el.name || ''
    let label = ''

    const labelById = id ? root.querySelector(`label[for="${id}"]`) : null
    if (labelById) label = labelById.innerText.trim()

    if (!label) {
      const parentLabel = el.closest('label')
      if (parentLabel) label = parentLabel.innerText.trim()
    }

    if (label) {
      choices.push({ id, group, text: label })
    }
  })

  const selects = []
  root.querySelectorAll('select').forEach(sel => {
    const id = sel.id || ''
    const name = sel.name || ''
    const options = [...sel.options].map(o => ({
      value: o.value,
      text: o.text.trim()
    }))

    selects.push({ id, name, options })
  })

  const dnd = {
    fields: [...root.querySelectorAll('.gxs-dnd-field')].length,
    options: [...root.querySelectorAll('.gxs-dnd-option')].map(o => ({
      id: o.dataset.id || '',
      text: o.innerText.trim()
    }))
  }

  const variants = []
  root.querySelectorAll('label').forEach(l => {
    const text = l.innerText.trim()
    if (text) variants.push(text)
  })

  root.querySelectorAll('.gxs-dnd-option').forEach(o => {
    const text = o.innerText.trim()
    if (text) variants.push(text)
  })

  root.querySelectorAll('select option').forEach(o => {
    const text = o.text.trim()
    if (text && text !== 'Выберите вариант') variants.push(text)
  })

  const uniqueVariants = []
  const seen = new Set()
  for (const variant of variants) {
    const key = normalizeText(variant)
    if (key && !seen.has(key)) {
      seen.add(key)
      uniqueVariants.push(variant)
    }
    if (uniqueVariants.length >= 220) break
  }

  const images = []
  root.querySelectorAll('img.gxs-resource-image, .taskhtmlwrapper img, .exercise-content img').forEach(img => {
    const url = absolutizeUrl(img.getAttribute('src') || img.getAttribute('data-src') || '')
    const alt = (img.getAttribute('alt') || '').trim()
    const width = Number(img.getAttribute('width') || img.naturalWidth || 0) || 0
    const height = Number(img.getAttribute('height') || img.naturalHeight || 0) || 0

    if (url) {
      images.push({ url, alt, width, height })
    }
  })

  return {
    success: true,
    text,
    html,
    inputs,
    choices,
    selects,
    dnd,
    variants: uniqueVariants,
    images
  }
}

function applyAnswer(answer) {
  console.log('applyAnswer called with:', answer)
  
  function normalizeText(text) {
    return (text || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2000-\u200F\u2028\u202F\u2060\uFEFF]/g, '')
      .toLowerCase()
      .replace(/[\u2212\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function compactText(text) {
    const normalized = normalizeText(text).replace(/\^/g, '')
    return normalized.replace(/[ \t\r\n()```math{}.,;:|]/g, '')
  }

  function countCommonChars(str1, str2) {
    const charMap = new Map()
    let count = 0

    for (const char of str1) {
      charMap.set(char, (charMap.get(char) || 0) + 1)
    }

    for (const char of str2) {
      const current = charMap.get(char) || 0
      if (current > 0) {
        count++
        charMap.set(char, current - 1)
      }
    }

    return count
  }

  function isTextMatch(text1, text2) {
    const t1 = normalizeText(text1)
    const t2 = normalizeText(text2)
    if (t1 === t2) return true

    const c1 = compactText(text1)
    const c2 = compactText(text2)
    if (c1 === c2) return true

    const ratio = (2 * countCommonChars(c1, c2)) / ((c1.length + c2.length) || 1)
    return ratio >= 0.9
  }

  function calculateSimilarity(text1, text2) {
    const c1 = compactText(text1)
    const c2 = compactText(text2)
    if (!c1 || !c2) return 0
    return (2 * countCommonChars(c1, c2)) / (c1.length + c2.length)
  }

  function escapeCssSelector(selector) {
    try {
      return (window.CSS && CSS.escape) ? CSS.escape(selector) : selector.replace(/[^a-zA-Z0-9_\-]/g, '\\$&')
    } catch (e) {
      return selector
    }
  }

  function isElementVisible(element) {
    return !!(element && element.offsetParent !== null)
  }

  function setInputValue(element, value) {
    try {
      if (element.tagName === 'INPUT') {
        const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        if (valueDescriptor && valueDescriptor.set) {
          valueDescriptor.set.call(element, value)
        } else {
          element.value = value
        }
      } else if (element.tagName === 'TEXTAREA') {
        const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        if (valueDescriptor && valueDescriptor.set) {
          valueDescriptor.set.call(element, value)
        } else {
          element.value = value
        }
      } else if (element.isContentEditable) {
        element.textContent = value
      } else {
        element.value = value
      }
    } catch (e) {
      element.value = value
    }
  }

  function triggerEvents(element) {
    element.dispatchEvent(new Event('focus', { bubbles: true }))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new Event('blur', { bubbles: true }))
  }

  try {
    const scope = document.querySelector('.taskForm') || document
    console.log('Scope found:', scope)

    if (Array.isArray(answer.items) && answer.items.length) {
      let successCount = 0
      console.log('Processing items array:', answer.items.length, 'items')
      for (const item of answer.items) {
        const result = applySingleAnswer(scope, item)
        console.log('Item result:', result)
        if (result.success) successCount++
      }
      const finalResult = successCount > 0
        ? { success: true, mode: 'items' }
        : { success: false, error: 'batch failed' }
      console.log('Batch result:', finalResult)
      return finalResult
    }

    console.log('Processing single answer')
    const result = applySingleAnswer(scope, answer)
    console.log('Single answer result:', result)
    return result

    function applySingleAnswer(scope, item) {
      console.log('applySingleAnswer called with mode:', item.mode, 'item:', item)
      const mode = (item.mode || '').toLowerCase()

      if (mode === 'text' || mode === 'number') {
        console.log('Processing TEXT/NUMBER field with value:', item.value);
        let field = null

        if (item.target) {
          if (item.target.id) {
            field = document.getElementById(item.target.id)
            console.log('Found field by ID:', field)
          }

          if (!field && item.target.name) {
            field = scope.querySelector(`input[name="${escapeCssSelector(item.target.name)}"],textarea[name="${escapeCssSelector(item.target.name)}"],[contenteditable="true"][name="${escapeCssSelector(item.target.name)}"]`)
            console.log('Found field by name:', field)
          }

          if (!field && item.target.label) {
            const labelText = normalizeText(item.target.label)
            const allInputs = [...scope.querySelectorAll('input[type="text"],input[type="number"],input.gxs-answer-number,textarea,[contenteditable="true"],input[name*="|tb"]')]

            let bestField = null
            let bestScore = 0

            for (const input of allInputs) {
              if (input.disabled || input.readOnly || !isElementVisible(input)) continue

              let inputLabel = ''
              const labelById = input.id ? scope.querySelector(`label[for="${input.id}"]`) : null
              if (labelById) inputLabel = labelById.innerText.trim()

              if (!inputLabel) {
                const parentLabel = input.closest('label')
                if (parentLabel) inputLabel = parentLabel.innerText.trim()
              }

              const score = calculateSimilarity(inputLabel, labelText)
              if (score > bestScore) {
                bestScore = score
                bestField = input
              }
            }

            field = bestField
          }
        }

        if (!field) {
          const selectors = [
            'input[type="text"]',
            'input[type="number"]', 
            'input.gxs-answer-number',
            'textarea',
            '[contenteditable="true"]',
            'input[name*="|tb"]',
            'input.form-control',
            'input.answer-input',
            '.answer-field input',
            '.gxs-answer input',
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"])'
          ]
          
          console.log('Searching with selectors:', selectors)
          for (const selector of selectors) {
            const elements = [...scope.querySelectorAll(selector)]
            console.log(`Selector "${selector}" found ${elements.length} elements`)
            
            field = elements.find(el => !el.disabled && !el.readOnly && isElementVisible(el))
            if (field) {
              console.log('Found field by selector:', selector, field)
              break
            }
          }
        }

        if (!field) {
          console.log('Trying desperate search for ANY input...')
          const allInputs = [...scope.querySelectorAll('input, textarea')]
          console.log('All inputs found:', allInputs.length, allInputs.map(i => ({tag: i.tagName, type: i.type, class: i.className, id: i.id})))
          field = allInputs.find(el => !el.disabled && !el.readOnly && isElementVisible(el))
          console.log('Desperate search result:', field)
        }

        if (!field) {
          console.log('No input field found!')
          return { success: false, error: 'No suitable input field found' }
        }

        const value = String(item.value ?? '')
        console.log('Setting value:', value, 'to field:', field)
        setInputValue(field, value)
        triggerEvents(field)
        console.log('Value set and events triggered')

        return { success: true, mode: 'text/number' }
      }

      if (mode === 'single') {
        console.log('Processing SINGLE field with choice:', item.choice, 'or choiceId:', item.choiceId);
        if (item.choiceId) {
          const radio = scope.querySelector(`#${escapeCssSelector(item.choiceId)}`)
          if (radio) {
            const label = scope.querySelector(`label[for="${escapeCssSelector(item.choiceId)}"]`) || radio.closest('label') || radio.parentElement?.querySelector('label')
            if (label && label.click) {
              label.click()
            } else if (radio.click) {
              radio.click()
            } else {
              radio.checked = true
            }
            radio.dispatchEvent(new Event('change', { bubbles: true }))
            return { success: true, mode: 'single-id' }
          }
        }

        const targetText = item.choice || ''
        const radios = [...scope.querySelectorAll('input[type="radio"],input[type="checkbox"]')]

        for (const radio of radios) {
          const label = scope.querySelector(`label[for="${radio.id}"]`) || radio.closest('label') || radio.parentElement?.querySelector('label')
          const labelText = label ? label.innerText.trim() : ''

          if (isTextMatch(labelText, targetText)) {
            if (label && label.click) {
              label.click()
            } else if (radio.click) {
              radio.click()
            } else {
              radio.checked = true
            }
            radio.dispatchEvent(new Event('change', { bubbles: true }))
            return { success: true, mode: 'single' }
          }
        }

        return { success: false, error: 'choice not found' }
      }

      if (mode === 'multi') {
        console.log('Processing MULTI field with choices:', item.choices, 'or choicesId:', item.choicesId);
        const ids = Array.isArray(item.choicesId) ? item.choicesId : []
        let selectedCount = 0

        if (ids.length) {
          for (const id of ids) {
            const checkbox = scope.querySelector(`#${escapeCssSelector(id)}`)
            if (checkbox) {
              const label = scope.querySelector(`label[for="${escapeCssSelector(id)}"]`) || checkbox.closest('label') || checkbox.parentElement?.querySelector('label')
              if (label && label.click) {
                label.click()
              } else if (checkbox.click) {
                checkbox.click()
              } else {
                checkbox.checked = true
              }
              checkbox.dispatchEvent(new Event('change', { bubbles: true }))
              selectedCount++
            }
          }
          if (selectedCount > 0) return { success: true, mode: 'multi-id' }
        }

        const targets = (item.choices || []).filter(Boolean)
        const checkboxes = [...scope.querySelectorAll('input[type="checkbox"]')]

        for (const checkbox of checkboxes) {
          const label = scope.querySelector(`label[for="${checkbox.id}"]`) || checkbox.closest('label') || checkbox.parentElement?.querySelector('label')
          const labelText = label ? label.innerText.trim() : ''

          for (const target of targets) {
            if (isTextMatch(labelText, target)) {
              if (label && label.click) {
                label.click()
              } else if (checkbox.click) {
                checkbox.click()
              } else {
                checkbox.checked = true
              }
              checkbox.dispatchEvent(new Event('change', { bubbles: true }))
              selectedCount++
              break
            }
          }
        }

        return selectedCount > 0
          ? { success: true, mode: 'multi' }
          : { success: false, error: 'choices not found' }
      }

      if (mode === 'select') {
        console.log('Processing SELECT field with select:', item.select, 'or selectValue:', item.selectValue);
        if (item.selectValue) {
          const selects = [...scope.querySelectorAll('select')]
          for (const select of selects) {
            const option = [...select.options].find(o => o.value === item.selectValue)
            if (option) {
              option.selected = true
              select.selectedIndex = [...select.options].indexOf(option)

              const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
              if (valueDescriptor && valueDescriptor.set) {
                valueDescriptor.set.call(select, option.value)
              } else {
                select.value = option.value
              }

              select.dispatchEvent(new Event('input', { bubbles: true }))
              select.dispatchEvent(new Event('change', { bubbles: true }))
              select.dispatchEvent(new Event('blur', { bubbles: true }))

              return { success: true, mode: 'select-id' }
            }
          }
        }

        const targetText = item.select || ''
        const selects = [...scope.querySelectorAll('select')]

        for (const select of selects) {
          let exactOption = null
          let bestOption = null
          let bestScore = 0

          for (const option of select.options) {
            const optionText = option.text.trim()

            if (isTextMatch(optionText, targetText)) {
              exactOption = option
              break
            }

            const score = calculateSimilarity(optionText, targetText)
            if (score > bestScore) {
              bestScore = score
              bestOption = option
            }
          }

          if (exactOption || bestScore >= 0.9) {
            const selectedOption = exactOption || bestOption
            if (selectedOption) {
              selectedOption.selected = true
              select.selectedIndex = [...select.options].indexOf(selectedOption)

              const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
              if (valueDescriptor && valueDescriptor.set) {
                valueDescriptor.set.call(select, selectedOption.value)
              } else {
                select.value = selectedOption.value
              }

              select.dispatchEvent(new Event('input', { bubbles: true }))
              select.dispatchEvent(new Event('change', { bubbles: true }))
              select.dispatchEvent(new Event('blur', { bubbles: true }))

              return { success: true, mode: 'select' }
            }
          }
        }

        return { success: false, error: 'select option not found' }
      }

      if (mode === 'order') {
        console.log('Processing ORDER field with order:', item.order, 'or orderIds:', item.orderIds);
        const fields = [...scope.querySelectorAll('.gxs-dnd-field')]
        const options = [...scope.querySelectorAll('.gxs-dnd-option')]

        if (!fields.length || !options.length) {
          return { success: false, error: 'dnd not found' }
        }

        const optionsById = new Map(options.map(o => [o.dataset.id, o]))
        const optionsByText = new Map()

        for (const option of options) {
          optionsByText.set(compactText(option.innerText), option)
          optionsByText.set(normalizeText(option.innerText), option)
        }

        let placedCount = 0

        if (Array.isArray(item.orderIds) && item.orderIds.length) {
          const limit = fields.length === 1 ? Math.min(1, item.orderIds.length) : Math.min(item.orderIds.length, fields.length)

          for (let i = 0; i < limit; i++) {
            const field = fields[i]
            const id = item.orderIds[i] || item.orderIds[0]
            const option = optionsById.get(id)

            if (!option) continue

            const hiddenInput = field.querySelector('input[type="hidden"]')
            if (!hiddenInput) continue

            const previous = field.querySelector('.gxs-dnd-option')
            if (previous) {
              previous.classList.remove('answer-placed')
              previous.removeAttribute('data-field-id')
              previous.remove()
            }

            option.classList.add('answer-placed')
            option.setAttribute('data-field-id', field.id)
            field.classList.add('answer-placed')
            field.appendChild(option)

            hiddenInput.value = id
            hiddenInput.dispatchEvent(new Event('input', { bubbles: true }))
            hiddenInput.dispatchEvent(new Event('change', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))

            placedCount++
          }

          if (placedCount > 0) {
            return { success: true, mode: placedCount === fields.length ? 'order' : 'order-partial' }
          }
        }

        const targets = (item.order || []).map(x => x.trim()).filter(Boolean)
        const limit = fields.length === 1 ? Math.min(1, targets.length || 1) : Math.min(targets.length, fields.length)

        for (let i = 0; i < limit; i++) {
          const field = fields[i]
          const target = targets[i] || targets[0] || ''

          let option = optionsByText.get(compactText(target)) || optionsByText.get(normalizeText(target))

          if (!option) {
            let bestOption = null
            let bestScore = 0
            for (const opt of options) {
              const score = calculateSimilarity(opt.innerText, target)
              if (score > bestScore) {
                bestScore = score
                bestOption = opt
              }
            }
            if (bestScore < 0.9) continue
            option = bestOption
          }

          const hiddenInput = field.querySelector('input[type="hidden"]')
          if (!hiddenInput) continue

          const previous = field.querySelector('.gxs-dnd-option')
          if (previous) {
            previous.classList.remove('answer-placed')
            previous.removeAttribute('data-field-id')
            previous.remove()
          }

          option.classList.add('answer-placed')
          option.setAttribute('data-field-id', field.id)
          field.classList.add('answer-placed')
          field.appendChild(option)

          if (option.dataset && option.dataset.id) {
            hiddenInput.value = option.dataset.id
          }

          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }))
          hiddenInput.dispatchEvent(new Event('change', { bubbles: true }))
          field.dispatchEvent(new Event('change', { bubbles: true }))

          placedCount++
        }

        if (placedCount > 0) {
          return { success: true, mode: placedCount === fields.length ? 'order' : 'order-partial' }
        }

        return { success: false, error: 'dnd placement failed' }
      }

      const fallbackInput = scope.querySelector('input[type="text"],textarea,[contenteditable="true"]')
      if (fallbackInput && typeof item.value !== 'undefined' && item.value !== null) {
        console.log('Using fallback for item:', item, 'with value:', item.value)
        const value = String(item.value ?? '')
        setInputValue(fallbackInput, value)
        triggerEvents(fallbackInput)
        return { success: true, mode: 'fallback-text' }
      }

      console.log('No applicable mode or value for item:', item)
      return { success: false, error: 'No applicable mode or value for item' }
    }

  } catch (e) {
    console.error('applyAnswer error:', e)
    const errorResult = { success: false, error: String(e) }
    console.log('Returning error result:', errorResult)
    return errorResult
  }
}


initialize().catch(error => {
  console.error('Failed to initialize YaKlass Resolver:', error)
})
