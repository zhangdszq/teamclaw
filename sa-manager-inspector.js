#!/usr/bin/env node

/**
 * SA Manager API Inspector
 * Automates login and API information extraction for sa-manager.lionabc.com
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function inspectSAManager() {
  const browser = await chromium.launch({ 
    headless: false,  // 显示浏览器窗口便于观察
    args: ['--start-maximized']
  });
  
  const context = await browser.newContext({
    viewport: null,
    recordVideo: { dir: 'recordings/' }  // 可选：录制视频
  });
  
  const page = await context.newPage();
  
  // 存储所有API请求
  const apiRequests = [];
  
  // 监听所有网络请求
  page.on('request', request => {
    const url = request.url();
    // 只记录API请求（排除静态资源）
    if (url.includes('/api/') || url.includes('/v1/') || 
        (request.resourceType() === 'xhr' || request.resourceType() === 'fetch')) {
      apiRequests.push({
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: url,
        headers: request.headers(),
        postData: request.postData(),
        resourceType: request.resourceType()
      });
    }
  });
  
  // 监听响应
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('/api/') || url.includes('/v1/') || 
        (response.request().resourceType() === 'xhr' || 
         response.request().resourceType() === 'fetch')) {
      try {
        const responseBody = await response.text();
        const request = apiRequests.find(r => r.url === url && !r.response);
        if (request) {
          request.response = {
            status: response.status(),
            headers: response.headers(),
            body: responseBody
          };
        }
      } catch (e) {
        console.log(`无法读取响应: ${url}`);
      }
    }
  });
  
  console.log('🌐 正在导航到 https://sa-manager.lionabc.com/ ...');
  await page.goto('https://sa-manager.lionabc.com/', { waitUntil: 'networkidle' });
  
  // 截图1：初始页面
  await page.screenshot({ path: 'screenshots/01-initial-page.png', fullPage: true });
  console.log('📸 已截图：初始页面');
  
  // 等待5秒，检查是否需要登录
  await page.waitForTimeout(5000);
  
  const currentUrl = page.url();
  console.log(`📍 当前URL: ${currentUrl}`);
  
  // 检查是否在登录页面
  const isLoginPage = currentUrl.includes('login') || 
                      await page.locator('input[type="password"]').count() > 0;
  
  if (isLoginPage) {
    console.log('🔐 检测到登录页面');
    console.log('⏳ 请在浏览器中手动完成登录...');
    console.log('💡 登录成功后，脚本将自动继续...');
    
    // 等待URL变化（登录成功）
    await page.waitForURL(url => {
      return typeof url === 'string' ? !url.includes('login') : true;
    }, { timeout: 300000 }); // 5分钟超时
    console.log('✅ 登录成功！');
    
    await page.waitForTimeout(3000);
  } else {
    console.log('✅ 已经是登录状态或无需登录');
  }
  
  // 提取认证信息
  console.log('\n📦 正在提取认证信息...');
  
  const authInfo = await page.evaluate(() => {
    const info = {
      cookies: document.cookie,
      localStorage: {},
      sessionStorage: {},
      authTokens: []
    };
    
    // 提取 LocalStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      info.localStorage[key] = value;
      
      // 检测token相关字段
      if (key.toLowerCase().includes('token') || 
          key.toLowerCase().includes('auth') ||
          key.toLowerCase().includes('session') ||
          key.toLowerCase().includes('jwt')) {
        info.authTokens.push({ source: 'localStorage', key, value });
      }
    }
    
    // 提取 SessionStorage
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const value = sessionStorage.getItem(key);
      info.sessionStorage[key] = value;
      
      // 检测token相关字段
      if (key.toLowerCase().includes('token') || 
          key.toLowerCase().includes('auth') ||
          key.toLowerCase().includes('session') ||
          key.toLowerCase().includes('jwt')) {
        info.authTokens.push({ source: 'sessionStorage', key, value });
      }
    }
    
    // 从Cookie中提取token
    document.cookie.split(';').forEach(cookie => {
      const [key, value] = cookie.trim().split('=');
      if (key.toLowerCase().includes('token') || 
          key.toLowerCase().includes('auth') ||
          key.toLowerCase().includes('session') ||
          key.toLowerCase().includes('jwt')) {
        info.authTokens.push({ source: 'cookie', key, value });
      }
    });
    
    return info;
  });
  
  // 截图2：主界面
  await page.screenshot({ path: 'screenshots/02-main-page.png', fullPage: true });
  console.log('📸 已截图：主界面');
  
  // 分析页面结构，查找"商品包"入口
  console.log('\n🔍 正在分析页面菜单结构...');
  
  const menuStructure = await page.evaluate(() => {
    const menus = [];
    
    // 尝试多种常见的菜单选择器
    const menuSelectors = [
      'nav a', 
      '.menu a', 
      '.sidebar a', 
      '[role="navigation"] a',
      '.ant-menu-item',
      '.el-menu-item'
    ];
    
    for (const selector of menuSelectors) {
      const items = document.querySelectorAll(selector);
      if (items.length > 0) {
        items.forEach(item => {
          menus.push({
            text: item.textContent.trim(),
            href: item.href || item.getAttribute('href'),
            selector: selector
          });
        });
        break;
      }
    }
    
    return menus;
  });
  
  console.log('📋 菜单结构：');
  menuStructure.forEach((item, index) => {
    console.log(`  ${index + 1}. ${item.text} -> ${item.href}`);
  });
  
  // 查找"商品包"相关入口
  const productPackageMenu = menuStructure.find(item => 
    item.text.includes('商品包') || 
    item.text.includes('产品包') ||
    item.text.includes('课程包') ||
    item.text.toLowerCase().includes('package') ||
    item.text.toLowerCase().includes('product')
  );
  
  if (productPackageMenu) {
    console.log(`\n✅ 找到商品包入口: ${productPackageMenu.text}`);
    console.log(`🔗 准备点击: ${productPackageMenu.href}`);
    
    // 点击进入商品包页面
    await page.click(`a:has-text("${productPackageMenu.text}")`);
    await page.waitForTimeout(3000);
    
    // 截图3：商品包页面
    await page.screenshot({ path: 'screenshots/03-package-page.png', fullPage: true });
    console.log('📸 已截图：商品包页面');
    
    // 查找并点击"新建"按钮
    const createButtonSelectors = [
      'button:has-text("新建")',
      'button:has-text("创建")',
      'button:has-text("添加")',
      'button:has-text("Create")',
      'button:has-text("Add")',
      '.ant-btn:has-text("新建")',
      '.el-button:has-text("新建")'
    ];
    
    for (const selector of createButtonSelectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.count() > 0) {
          console.log(`\n🆕 找到创建按钮，准备点击...`);
          await button.click();
          await page.waitForTimeout(2000);
          
          // 截图4：创建表单
          await page.screenshot({ path: 'screenshots/04-create-form.png', fullPage: true });
          console.log('📸 已截图：创建表单');
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } else {
    console.log('\n⚠️  未找到"商品包"相关菜单，请手动导航');
    console.log('💡 按任意键继续，或在浏览器中手动操作...');
  }
  
  // 等待用户操作，收集更多API请求
  console.log('\n⏳ 等待30秒以收集API请求信息...');
  console.log('💡 请在浏览器中进行以下操作：');
  console.log('   - 查询/列表商品包');
  console.log('   - 点击新建按钮');
  console.log('   - 查看详情');
  await page.waitForTimeout(30000);
  
  // 导出所有收集到的信息
  console.log('\n📊 正在生成报告...');
  
  const report = {
    timestamp: new Date().toISOString(),
    baseUrl: 'https://sa-manager.lionabc.com',
    authInfo: authInfo,
    menuStructure: menuStructure,
    apiRequests: apiRequests,
    summary: {
      totalRequests: apiRequests.length,
      uniqueEndpoints: [...new Set(apiRequests.map(r => `${r.method} ${new URL(r.url).pathname}`))],
      authTokensFound: authInfo.authTokens.length
    }
  };
  
  // 保存完整报告
  const reportPath = 'sa-manager-report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`✅ 完整报告已保存: ${reportPath}`);
  
  // 生成可读的API文档
  const apiDoc = generateApiDoc(report);
  const docPath = 'sa-manager-api-doc.md';
  fs.writeFileSync(docPath, apiDoc);
  console.log(`✅ API文档已保存: ${docPath}`);
  
  // 输出摘要
  console.log('\n' + '='.repeat(60));
  console.log('📋 提取结果摘要');
  console.log('='.repeat(60));
  
  console.log('\n🔑 认证Token:');
  if (authInfo.authTokens.length > 0) {
    authInfo.authTokens.forEach(token => {
      console.log(`  [${token.source}] ${token.key}: ${token.value.substring(0, 50)}...`);
    });
  } else {
    console.log('  ⚠️  未找到明确的token字段');
  }
  
  console.log('\n🌐 Base URL:');
  console.log(`  ${report.baseUrl}`);
  
  console.log('\n📡 发现的API端点 (共 ${report.summary.uniqueEndpoints.length} 个):');
  report.summary.uniqueEndpoints.forEach((endpoint, index) => {
    console.log(`  ${index + 1}. ${endpoint}`);
  });
  
  console.log('\n✅ 任务完成！请查看生成的文件：');
  console.log(`   - ${reportPath} (完整JSON报告)`);
  console.log(`   - ${docPath} (可读API文档)`);
  console.log(`   - screenshots/ (页面截图)`);
  
  // 保持浏览器打开30秒以便检查
  console.log('\n💡 浏览器将在30秒后关闭...');
  await page.waitForTimeout(30000);
  
  await browser.close();
}

function generateApiDoc(report) {
  let doc = `# SA Manager API Documentation\n\n`;
  doc += `> 生成时间: ${report.timestamp}\n\n`;
  
  doc += `## 🔐 认证信息\n\n`;
  doc += `### Auth Tokens\n\n`;
  if (report.authInfo.authTokens.length > 0) {
    report.authInfo.authTokens.forEach(token => {
      doc += `**${token.key}** (来源: ${token.source})\n`;
      doc += `\`\`\`\n${token.value}\n\`\`\`\n\n`;
    });
  } else {
    doc += `未找到明确的token字段\n\n`;
  }
  
  doc += `### Cookies\n\n`;
  doc += `\`\`\`\n${report.authInfo.cookies}\n\`\`\`\n\n`;
  
  doc += `### LocalStorage\n\n`;
  doc += `\`\`\`json\n${JSON.stringify(report.authInfo.localStorage, null, 2)}\n\`\`\`\n\n`;
  
  doc += `## 🌐 Base URL\n\n`;
  doc += `\`${report.baseUrl}\`\n\n`;
  
  doc += `## 📋 菜单结构\n\n`;
  report.menuStructure.forEach((item, index) => {
    doc += `${index + 1}. **${item.text}** → \`${item.href}\`\n`;
  });
  
  doc += `\n## 📡 API端点列表\n\n`;
  doc += `共发现 ${report.apiRequests.length} 个API请求\n\n`;
  
  // 按endpoint分组
  const groupedRequests = {};
  report.apiRequests.forEach(req => {
    const endpoint = `${req.method} ${new URL(req.url).pathname}`;
    if (!groupedRequests[endpoint]) {
      groupedRequests[endpoint] = [];
    }
    groupedRequests[endpoint].push(req);
  });
  
  Object.entries(groupedRequests).forEach(([endpoint, requests]) => {
    const firstReq = requests[0];
    doc += `### ${endpoint}\n\n`;
    doc += `**完整URL**: \`${firstReq.url}\`\n\n`;
    doc += `**调用次数**: ${requests.length}\n\n`;
    
    doc += `**Request Headers**:\n\`\`\`json\n${JSON.stringify(firstReq.headers, null, 2)}\n\`\`\`\n\n`;
    
    if (firstReq.postData) {
      doc += `**Request Body**:\n\`\`\`json\n${firstReq.postData}\n\`\`\`\n\n`;
    }
    
    if (firstReq.response) {
      doc += `**Response Status**: ${firstReq.response.status}\n\n`;
      doc += `**Response Body**:\n\`\`\`json\n${firstReq.response.body}\n\`\`\`\n\n`;
    }
    
    doc += `---\n\n`;
  });
  
  return doc;
}

// 创建必要的目录
if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

// 运行
inspectSAManager().catch(console.error);
