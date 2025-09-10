document.addEventListener('DOMContentLoaded', () => {
  const solveButton = document.getElementById('solveButton')
  const statusDiv = document.getElementById('status')

  const ui = {
    set: (text, color) => {
      statusDiv.textContent = text
      statusDiv.style.color = color || '#9ca3af'
    },
    success: (text) => ui.set(`✅ ${text}`, '#10b981'),
    error: (text) => ui.set(`❌ ${text}`, '#ef4444'),
    info: (text) => ui.set(`ℹ️ ${text}`, '#6c7fff'),
    warning: (text) => ui.set(`⚠️ ${text}`, '#f59e0b'),
    reset: () => {
      solveButton.disabled = false
      solveButton.textContent = 'Решить'
    }
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0]
    const isYaklassPage = /yaklass\.ru/.test(currentTab?.url || '')

    if (isYaklassPage) {
      ui.set('🎯 Страница с заданием обнаружена', '#10b981')
    } else {
      ui.error('Откройте страницу ЯКласс с заданием')
      solveButton.disabled = true
    }
  })

  solveButton.addEventListener('click', async () => {
    solveButton.disabled = true
    solveButton.textContent = '⏳ Работаю...'
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.style.transition = `width 90000ms linear`;
    setTimeout(() => progressBar.style.width = '100%', 50);

    ui.info('Собираю данные о задании...')

    const operationTimeout = setTimeout(() => {
      ui.error('Превышено время ожидания. Попробуйте снова.')
      ui.reset()
      document.getElementById('progressContainer').style.display = 'none';
    }, 90000)

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'SOLVE_TASK' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
            return
          }

          if (!response) {
            reject(new Error('Нет ответа от background script'))
            return
          }

          resolve(response)
        })
      })

      clearTimeout(operationTimeout)

      if (response.status === 'success') {
        ui.success(response.message || 'Задание решено!')
        document.getElementById('progressContainer').style.display = 'none';
        solveButton.textContent = '✅ Готово!'

        setTimeout(() => {
          window.close()
        }, 3000)
      } else {
        ui.error(response.message || 'Произошла неизвестная ошибка')
        ui.reset()
        document.getElementById('progressContainer').style.display = 'none';
      }

    } catch (error) {
      clearTimeout(operationTimeout)
      console.error('Solve task error:', error)

      let errorMessage = 'Произошла ошибка'

      if (error.message.includes('API')) {
        errorMessage = 'Ошибка API. Проверьте подключение к интернету.'
      } else if (error.message.includes('timeout') || error.message.includes('время')) {
        errorMessage = 'Превышено время ожидания. Попробуйте снова.'
      } else if (error.message.includes('задание') || error.message.includes('task')) {
        errorMessage = 'Не удалось найти задание на странице.'
      } else if (error.message) {
        errorMessage = error.message
      }

      ui.error(errorMessage)
      ui.reset()
      document.getElementById('progressContainer').style.display = 'none';
    }
  })

  window.addEventListener('beforeunload', () => {
    if (solveButton.disabled) {
      solveButton.disabled = false
      solveButton.textContent = 'Решить'
    }
  })
})