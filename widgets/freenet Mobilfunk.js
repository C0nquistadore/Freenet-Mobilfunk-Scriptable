// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: signal;
///<reference path='../index.d.ts' />

const debug        = false
const appName      = 'freenet Mobilfunk'
const clientId     = ''
const clientSecret = ''


class FreenetWidget {

  constructor() {
    this.fileManager = FileManager.iCloud()
    this.documentsDirectory = this.fileManager.joinPath(this.fileManager.documentsDirectory(), appName)
    if (!this.fileManager.isDirectory(this.documentsDirectory)) {
      console.log(`Creating directory: ${this.documentsDirectory}`)
      this.fileManager.createDirectory(this.documentsDirectory)
    }
    this.shouldAuthenticateWithCredentials = clientId && clientSecret
  }

  async createSmallWidget() {
    const list = new ListWidget()

    let data = {}, fresh = 0
    try {
      const accessToken = await this.getAccessToken()
      data = await this.collectData(accessToken);
      fresh = 1
    } catch (error) {
      if (debug) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      return this.createErrorPresentation(message)
    }

    const line1 = list.addText(appName)
    line1.font = Font.lightSystemFont(14)

    const line2 = list.addText(data.usedPercentage + '%')
    line2.font = Font.boldSystemFont(36)
    line2.textColor = Color.green()
    if (data.usedPercentage >= 75) {
      line2.textColor = Color.orange()
    } else if (data.usedPercentage >= 90) {
      line2.textColor = Color.red()
    }

    const line3 = list.addText(data.usedVolumeStr + ' / ' + data.initialVolumeStr)
    line3.font = Font.mediumSystemFont(12)

    list.addSpacer(4)

    let line4, line5
    if (data.remainingTimeStr) {
      line4 = list.addText('Period ends in:')
      line4.font = Font.mediumSystemFont(12)

      line5 = list.addText(data.remainingTimeStr)
      line5.font = Font.mediumSystemFont(12)
    }

    // Gray out if local data instead of Telekom API data:
    if (fresh == 0) {
      line1.textColor = Color.darkGray()
      line2.textColor = Color.darkGray()
      line3.textColor = Color.darkGray()
      if (data.remainingTimeStr) {
        line4.textColor = Color.darkGray()
        line5.textColor = Color.darkGray()
      }
    }

    // Add time of last widget refresh:
    list.addSpacer()
    list.addSpacer()
    const now = new Date();
    const timeLabel = list.addDate(now)
    timeLabel.font = Font.lightSystemFont(10)
    timeLabel.centerAlignText()
    timeLabel.applyTimeStyle()
    timeLabel.textColor = Color.gray()

    return list
  }

  async getAccessToken() {
    const sessionFilePath = this.fileManager.joinPath(this.documentsDirectory, 'session.json')
    let session
    if (this.fileManager.fileExists(sessionFilePath)) {
      if (!this.fileManager.isFileDownloaded(sessionFilePath)) {
        console.log(`Downloading iCloud file: ${sessionFilePath}`)
        await this.fileManager.downloadFileFromiCloud(sessionFilePath)
      }
      const content = await this.fileManager.readString(sessionFilePath)
      session = JSON.parse(content)
    }
    else {
      console.log(`File does not exist: ${sessionFilePath}`)
    }

    if (session) {
      console.log('Using cached session')
      if (new Date() >= new Date(session.expires_at)) {
        console.log('Cached session has expired and is being refreshed')
        session = await this.refreshSession(session)
        this.storeSession(session, sessionFilePath)
      }
      else {
        console.log('Cached session is still valid')
      }
    }
    else {
      session = await this.authenticate()
      this.storeSession(session, sessionFilePath)
    }

    const accessToken = session.access_token
    return accessToken
  }

  async authenticate() {
    let session
    if (this.shouldAuthenticateWithCredentials) {
      console.log('Prompting user for credentials')
      const credentials = await this.promptForCredentials()
      console.log('Aquiring access token using credentials')
      session = await this.authenticateWithCredentials(credentials)
    }
    else {
      console.log('Acquiring access token via web view')
      session = await this.authenticateUsingWebViewCookie()
    }
    return session;
  }

  async refreshSession(session) {
    const newSession = await (this.shouldAuthenticateWithCredentials ? this.refreshToken(session.refresh_token) : this.authenticateUsingWebViewCookie())
    return newSession
  }

  async storeSession(session, sessionFilePath) {
    if (session.jwt) {
      const expirationDate = new Date(0)
      expirationDate.setUTCSeconds(session.jwt.exp)
      session.expires_at = expirationDate.toISOString()
    }
    else {
      session.expires_at = new Date(Date.now() + session.expires_in * 1000).toISOString()
    }

    await this.replaceJsonFileContents(sessionFilePath, session)
    console.log('Updated session cache')
  }

  async promptForCredentials() {
    if (config.runsInWidget) {
      throw 'You have to run this script inside the app first'
    }

    const promptCredentails = new Alert()
    promptCredentails.title = 'Credentials'
    promptCredentails.message = 'Please enter your credentials'
    promptCredentails.addTextField('Username')
    promptCredentails.addSecureTextField('Password')
    promptCredentails.addAction('Continue')

    await promptCredentails.present()
    const user = promptCredentails.textFieldValue(0).trim()
    const pass = promptCredentails.textFieldValue(1).trim()
    const result = {
      username: user,
      password: pass
    }
    return result
  }

  async authenticateWithCredentials(credentials) {
    const debugOutputPath = this.fileManager.joinPath(this.documentsDirectory, 'last-auth-response.json')
    const request = new Request('https://api.freenet-mobilfunk.de/v2/oidc/token')
    request.method = 'POST'
    request.headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
    request.body = `grant_type=password&username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}&client_id=${clientId}&client_secret=${clientSecret}`

    const kind = 'Authentication'
    let responseBody
    try {
      responseBody = await request.loadJSON()
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody)

      if (!responseBody.access_token) {
        throw Error('Authentication failed: Did not receive an access token')
      }

      return responseBody
    } catch (err) {
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody, err)
    }
  }

  async authenticateUsingWebViewCookie() {
    if (config.runsInWidget) {
      throw 'You have to run this script inside the app first'
    }

    const webview = new WebView()
    await webview.loadURL('https://freenet-mobilfunk.de/online-service')
    await webview.present(false)
    let result = await webview.evaluateJavaScript('JSON.parse(sessionStorage.getItem(\'oidcdata\'))')

    if (!result.access_token) {
      throw Error('Authentication failed: Did not receive an access token')
    }

    return result;
  }

  async refreshToken(refreshToken) {
    const debugOutputPath = this.fileManager.joinPath(this.documentsDirectory, 'last-refresh-token-response.json')
    const request = new Request('https://api.freenet-mobilfunk.de/v2/oidc/token')
    request.method = 'POST'
    request.headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
    request.body = `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${clientId}&client_secret=${clientSecret}`

    const kind = 'Refreshing token'
    let responseBody;
    try {
      responseBody = await request.loadJSON()
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody)

      if (!responseBody.access_token) {
        throw Error('Refreshing token failed: Did not receive a new access token')
      }

      return responseBody
    } catch (err) {
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody, err)
    }
  }

  async collectData(accessToken) {
    const debugOutputPath = this.fileManager.joinPath(this.documentsDirectory, 'last-data-response.json')
    const request = new Request('https://graphql.mobilcom-debitel.services/cucina')
    request.method = 'POST'
    request.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    }
    request.body = JSON.stringify({
      query: 'query Customer($acceptedCustomerFilter: String!) {\n  me(acceptedCustomerFilter: $acceptedCustomerFilter) {\n    customerProducts(\n      sortBy: START_DATE\n      sortOrder: DESCENDING\n      includeTerminated: false\n      categories: [MOBILE_CREDIT_SERVICES]\n    ) {\n      costUsageBalance {\n        usageQuotas {\n          ...customerUsageQuotas\n        }\n      }\n    }\n  }\n}\nfragment customerUsageQuotas on CostUsageBalanceUsageQuota {\n  validFor {\n    endDate\n  }\n  initialAmount\n  usedAmount\n}',
      variables: {
        acceptedCustomerFilter: 'mdAppCustomers'
      }
    })

    const kind = 'Collecting data'
    let responseBody;
    try {
      responseBody = await request.loadJSON()
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody)
      const result = this.convertDataResponse(responseBody)
      return result;
    } catch (err) {
      await this.handleHttpResponse(kind, debugOutputPath, request, responseBody, err)
    }
  }

  convertDataResponse(responseBody) {
    const quotas = responseBody.data.me.customerProducts[0].costUsageBalance.usageQuotas[0]
    const usedPercentage = Math.round(quotas.usedAmount / quotas.initialAmount * 100)
    const usedVolumeStr = `${Math.round(quotas.usedAmount / 10000) / 100} GB`
    const initialVolumeStr = `${Math.round(quotas.initialAmount / 10000) / 100} GB`
    const remainingTimeStr = this.humanizeDuration(this.getDuration(new Date(quotas.validFor.endDate) - new Date()))
    const result = {
      usedPercentage: usedPercentage,
      usedVolumeStr: usedVolumeStr,
      initialVolumeStr: initialVolumeStr,
      remainingTimeStr: remainingTimeStr
    }
    return result
  }

  async handleHttpResponse(kind, debugOutputPath, request, responseBody, error) {
    console.log(`${request.method} ${request.url} -> ${request.response.statusCode}`)
    await this.writeHttpDebugOutput(debugOutputPath, request, responseBody, error)
    if (responseBody?.error_description) {
      throw Error(`${kind} failed: ${responseBody.error_description}`)
    }
    if (error) {
      if (debug) {
        throw error
      }
      throw Error(`${kind} failed for unknown reasons.`)
    }
  }

  async writeHttpDebugOutput(outputPath, request, responseBody, error) {
    const debugInfo = { error: error, request: request, responseBody: responseBody ?? await request.loadString() }
    await this.replaceJsonFileContents(outputPath, debugInfo)
  }

  async replaceJsonFileContents(path, content) {
    // On iOS, files are not overwritten and suffixed with a number each time
    if (this.fileManager.fileExists(path)) {
      console.log(`Removing existing file: ${path}`)
      await this.fileManager.remove(path)
    }
    await this.fileManager.writeString(path, JSON.stringify(content, null, 2).replace(/password=[^&\s"]+/g, 'password=*****'))
  }

  createErrorPresentation(errorMessage) {
    const errorList = new ListWidget()
    errorList.addText(errorMessage)
    return errorList
  }

  getDuration(durationInMilliseconds) {
    const days = Math.floor(durationInMilliseconds / 86400000)
    durationInMilliseconds -= days * 86400000

    const hours = Math.floor(durationInMilliseconds / 3600000)
    durationInMilliseconds -= hours * 3600000

    const minutes = Math.floor(durationInMilliseconds / 60000)
    durationInMilliseconds -= minutes * 60000

    const seconds = Math.floor(durationInMilliseconds / 1000)
    durationInMilliseconds -= seconds * 1000

    const result = {
      days,
      hours,
      minutes,
      seconds
    }
    return result
  }

  humanizeDuration(duration) {
    if (duration.years > 0) { return `${duration.years} years ${duration.months} months ${duration.days} days ${duration.hours} hours ${duration.minutes} minutes` }
    if (duration.months > 0) { return `${duration.months} months ${duration.days} days ${duration.hours} hours ${duration.minutes} minutes` }
    if (duration.days > 0) { return `${duration.days} days ${duration.hours} hours ${duration.minutes} minutes` }
    if (duration.hours > 0) { return `${duration.hours} hours ${duration.minutes} minutes` }
    if (duration.minutes > 0) { return `${duration.minutes} minutes` }
    if (duration.seconds > 0) { return `${duration.seconds} seconds` }
    return 'Now';
  }
}

const freenetWidget = new FreenetWidget()

const widget = await freenetWidget.createSmallWidget()
widget.backgroundColor = new Color('#00777777')

if (!config.runsInWidget) {
  await widget.presentSmall()
}
else {
  Script.setWidget(widget)
  Script.complete()
}