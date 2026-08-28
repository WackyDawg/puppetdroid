import { Puppetdroid, KeyCodes } from '../src/index.js';

(async () => {
    console.log('🤖 Starting Android automation example...');

    try {
        // Check if ADB is available
        const adbAvailable = await Puppetdroid.checkADB();
        if (!adbAvailable) {
            throw new Error('ADB is not available. Please install Android SDK and add adb to PATH.');
        }

        // List connected devices
        const devices = await Puppetdroid.devices();
        console.log('📱 Connected devices:', devices);

        // Connect to device
        console.log('📱 Connecting to Android device...');
        const device = await Puppetdroid.connect();
        
        // Get device info
        const deviceInfo = await device.getDeviceInfo();
        console.log(`📱 Device: ${deviceInfo.brand} ${deviceInfo.model} (Android ${deviceInfo.version})`);

        // Get screen size
        const screenSize = await device.getScreenSize();
        console.log(`📱 Screen size: ${screenSize.width}x${screenSize.height}`);

        // Example 1: Launch Chrome and navigate
        console.log('🌐 Launching Chrome...');
        const page = await device.launch('com.android.chrome');
        
        // Wait for Chrome to load
        await page.waitForTimeout(3000);

        // Take a screenshot
        console.log('📸 Taking screenshot...');
        await page.screenshot({ path: 'chrome-home.png' });

        // Try to find the address bar and search
        try {
            const addressBar = await page.waitForSelector({
                resourceId: 'com.android.chrome:id/search_box_text',
                clickable: true
            }, { timeout: 5000 });

            if (addressBar) {
                console.log('🔍 Found address bar, typing search query...');
                await addressBar.click();
                await page.type(addressBar, 'Android automation testing');
                await page.pressKey(KeyCodes.ENTER);
                
                // Wait for results
                await page.waitForTimeout(3000);
                await page.screenshot({ path: 'chrome-search.png' });
            }
        } catch (error) {
            console.log('❌ Could not find address bar:', error.message);
        }

        // Example 2: Test scrolling
        console.log('📜 Testing scroll gestures...');
        await page.scroll('down', 500);
        await page.waitForTimeout(1000);
        await page.scroll('up', 500);
        await page.waitForTimeout(1000);

        // Example 3: Navigate back to home
        console.log('🏠 Going to home screen...');
        await page.goHome();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'home-screen.png' });

        // Example 4: Find and interact with apps on home screen
        console.log('🔍 Looking for apps on home screen...');
        const clickableElements = await page.selector.findClickableElements();
        console.log(`📱 Found ${clickableElements.length} clickable elements on home screen`);

        // Example 5: Get all text on screen
        const allText = await page.getAllText();
        console.log('📝 Text on screen:', allText.slice(0, 5)); // Show first 5 text elements

        // Example 6: Test different selector types
        console.log('🎯 Testing different selectors...');
        
        // Find by text content
        const textElements = await page.$$({ contains: 'app' });
        console.log(`📝 Found ${textElements.length} elements containing "app"`);

        // Find by class name
        const imageViews = await page.$$({ className: 'android.widget.ImageView' });
        console.log(`🖼️ Found ${imageViews.length} ImageView elements`);

        // Example 7: Test XPath-like selectors
        try {
            const allElements = await page.$x('//*');
            console.log(`🔍 Found ${allElements.length} total elements using XPath`);
        } catch (error) {
            console.log('❌ XPath test failed:', error.message);
        }

        // Example 8: Test app management
        console.log('📱 Testing app management...');
        
        // Get installed apps
        const installedApps = await device.getInstalledApps();
        console.log(`📱 Found ${installedApps.length} third-party apps installed`);
        
        // Check if specific apps are installed
        const isGmailInstalled = await device.isAppInstalled('com.google.android.gm');
        console.log(`📧 Gmail installed: ${isGmailInstalled}`);
        
        const isWhatsAppInstalled = await device.isAppInstalled('com.whatsapp');
        console.log(`💬 WhatsApp installed: ${isWhatsAppInstalled}`);

        // Example 9: Test Settings app navigation
        console.log('⚙️ Testing Settings app...');
        try {
            await device.launch('com.android.settings');
            await page.waitForTimeout(2000);
            
            // Look for WiFi settings
            const wifiSetting = await page.$({ contains: 'Wi' });
            if (wifiSetting) {
                console.log('📶 Found WiFi setting');
                await page.screenshot({ path: 'settings-main.png' });
            }
            
            await page.goBack();
            await page.waitForTimeout(1000);
        } catch (error) {
            console.log('❌ Settings test failed:', error.message);
        }

        // Example 10: Test system information
        console.log('📊 Getting system information...');
        
        const batteryLevel = await device.getBatteryLevel();
        console.log(`🔋 Battery level: ${batteryLevel}%`);
        
        const batteryStatus = await device.getBatteryStatus();
        console.log('🔋 Battery status:', batteryStatus);
        
        const memoryInfo = await device.getMemoryInfo();
        console.log(`💾 Total RAM: ${Math.round(memoryInfo.MemTotal / 1024)}MB`);
        console.log(`💾 Available RAM: ${Math.round(memoryInfo.MemAvailable / 1024)}MB`);

        // Example 11: Test gesture combinations
        console.log('👆 Testing advanced gestures...');
        
        // Test pull to refresh gesture
        await page.pullToRefresh();
        await page.waitForTimeout(1000);
        
        // Test edge swipe (like back gesture)
        const screenInfo = await device.getScreenSize();
        await page.gestures.edgeSwipe('left', 100);
        await page.waitForTimeout(1000);

        // Example 12: Test file operations
        console.log('📁 Testing file operations...');
        
        try {
            // Create a test directory
            await device.createDirectory('/sdcard/puppetdroid_test');
            
            // Check if directory exists
            const dirExists = await device.fileExists('/sdcard/puppetdroid_test');
            console.log(`📁 Test directory created: ${dirExists}`);
            
            // Clean up
            if (dirExists) {
                await device.removeDirectory('/sdcard/puppetdroid_test');
                console.log('🗑️ Test directory cleaned up');
            }
        } catch (error) {
            console.log('❌ File operations test failed:', error.message);
        }

        // Example 13: Test advanced element interactions
        console.log('🎯 Testing advanced element interactions...');
        
        // Launch Calculator app if available
        try {
            await device.launch('com.google.android.calculator');
            await page.waitForTimeout(2000);
            
            // Try to find number buttons and perform a calculation
            const button1 = await page.$({ text: '1' });
            const buttonPlus = await page.$({ text: '+' });
            const button2 = await page.$({ text: '2' });
            const buttonEquals = await page.$({ text: '=' });
            
            if (button1 && buttonPlus && button2 && buttonEquals) {
                console.log('🧮 Performing calculation: 1 + 2');
                await button1.click();
                await page.waitForTimeout(300);
                await buttonPlus.click();
                await page.waitForTimeout(300);
                await button2.click();
                await page.waitForTimeout(300);
                await buttonEquals.click();
                await page.waitForTimeout(1000);
                
                await page.screenshot({ path: 'calculator-result.png' });
                console.log('🧮 Calculator test completed');
            }
            
            await page.goHome();
        } catch (error) {
            console.log('❌ Calculator test failed:', error.message);
        }

        // Example 14: Test waiting for elements
        console.log('⏳ Testing wait conditions...');
        
        try {
            // Test waiting for an element that should appear
            await device.launch('com.android.settings');
            
            const settingsElement = await page.waitForSelector(
                { className: 'android.widget.ListView' },
                { timeout: 5000 }
            );
            
            if (settingsElement) {
                console.log('✅ Successfully waited for settings list to appear');
            }
            
            // Test waiting for text
            const wifiElement = await page.waitForText('Wi', { timeout: 3000, exact: false });
            if (wifiElement) {
                console.log('✅ Successfully found WiFi-related text');
            }
            
        } catch (error) {
            console.log('❌ Wait conditions test failed:', error.message);
        }

        // Example 15: Test error handling and recovery
        console.log('🛡️ Testing error handling...');
        
        try {
            // Try to interact with a non-existent element
            await page.click({ text: 'ThisElementDoesNotExist' });
        } catch (error) {
            console.log('✅ Error handling working correctly:', error.message.substring(0, 50) + '...');
        }
        
        try {
            // Try to launch a non-existent app
            await device.launch('com.nonexistent.app');
        } catch (error) {
            console.log('✅ App launch error handling working correctly');
        }

        // Example 16: Performance and debugging
        console.log('🔍 Getting performance information...');
        
        try {
            const topProcesses = await device.getTopProcesses(5);
            console.log('🔝 Top processes preview:', topProcesses.split('\n').slice(0, 8).join('\n'));
            
            const runningProcesses = await device.getRunningProcesses();
            console.log(`⚡ Found ${runningProcesses.length} running processes`);
            
        } catch (error) {
            console.log('❌ Performance info failed:', error.message);
        }

        // Final cleanup and summary
        console.log('🧹 Final cleanup...');
        await page.goHome();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'final-home.png' });

        console.log('✅ All automation examples completed successfully!');
        console.log('📸 Screenshots saved:');
        console.log('  - chrome-home.png');
        console.log('  - chrome-search.png (if search worked)');
        console.log('  - home-screen.png');
        console.log('  - settings-main.png (if settings worked)');
        console.log('  - calculator-result.png (if calculator worked)');
        console.log('  - final-home.png');

        // Disconnect from device
        await device.disconnect();

    } catch (error) {
        console.error('❌ Automation failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
})();

// Additional utility examples

/**
 * Example: Custom automation function for login
 */
export async function automateLogin(device, username, password) {
    console.log('🔐 Automating login process...');
    const page = device.page;
    
    try {
        // Find username field (multiple possible selectors)
        const usernameField = await page.waitForSelector([
            { resourceId: /.*username.*/ },
            { resourceId: /.*email.*/ },
            { hint: /.*username.*|.*email.*/i },
            { text: /.*username.*|.*email.*/i }
        ], { timeout: 10000 });
        
        if (usernameField) {
            await usernameField.type(username);
            console.log('✅ Username entered');
        }
        
        // Find password field
        const passwordField = await page.waitForSelector([
            { resourceId: /.*password.*/ },
            { className: 'android.widget.EditText', password: 'true' }
        ], { timeout: 5000 });
        
        if (passwordField) {
            await passwordField.type(password);
            console.log('✅ Password entered');
        }
        
        // Find and click login button
        const loginButton = await page.waitForSelector([
            { text: /.*login.*|.*sign in.*/i },
            { contentDesc: /.*login.*|.*sign in.*/i },
            { resourceId: /.*login.*|.*signin.*/i }
        ], { timeout: 5000 });
        
        if (loginButton) {
            await loginButton.click();
            console.log('✅ Login button clicked');
            
            // Wait for navigation or success indicator
            await page.waitForTimeout(3000);
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('❌ Login automation failed:', error.message);
        return false;
    }
}

/**
 * Example: Custom function to find and interact with specific UI patterns
 */
export async function findAndInteractWithList(device, listItemText) {
    console.log(`📋 Looking for list item: ${listItemText}`);
    const page = device.page;
    
    try {
        // First, find scrollable containers
        const scrollableElements = await page.selector.findScrollableElements();
        
        for (const scrollable of scrollableElements) {
            // Scroll through the list to find the item
            for (let i = 0; i < 5; i++) {
                const item = await page.$({ contains: listItemText });
                if (item && await item.isVisible()) {
                    await item.click();
                    console.log(`✅ Found and clicked: ${listItemText}`);
                    return item;
                }
                
                // Scroll down in this container
                await scrollable.swipe('down');
                await page.waitForTimeout(500);
            }
        }
        
        console.log(`❌ Could not find list item: ${listItemText}`);
        return null;
    } catch (error) {
        console.error('❌ List interaction failed:', error.message);
        return null;
    }
}

/**
 * Example: Take screenshots of all app screens
 */
export async function screenshotAllScreens(device, appPackage, maxScreens = 10) {
    console.log(`📸 Taking screenshots of ${appPackage}...`);
    const page = device.page;
    
    try {
        await device.launch(appPackage);
        const screenshots = [];
        
        for (let i = 0; i < maxScreens; i++) {
            const filename = `${appPackage}-screen-${i + 1}.png`;
            await page.screenshot({ path: filename });
            screenshots.push(filename);
            
            // Try to navigate to next screen
            const clickableElements = await page.selector.findClickableElements();
            if (clickableElements.length > 0) {
                // Click on the first clickable element that's not a back button
                for (const element of clickableElements) {
                    if (!element.contentDesc.toLowerCase().includes('back') && 
                        !element.text.toLowerCase().includes('back')) {
                        try {
                            await element.click();
                            await page.waitForTimeout(2000);
                            break;
                        } catch (error) {
                            continue;
                        }
                    }
                }
            } else {
                break; // No more clickable elements
            }
        }
        
        console.log(`✅ Captured ${screenshots.length} screenshots`);
        return screenshots;
    } catch (error) {
        console.error('❌ Screenshot automation failed:', error.message);
        return [];
    }
}