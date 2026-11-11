#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#import <sys/proc_info.h>
#include <unistd.h>
static void out(NSDictionary *value) {
 NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
 fwrite(data.bytes,1,data.length,stdout); puts("");
}
int main(void) { @autoreleasepool {
 NSArray<NSRunningApplication *> *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.culturedcode.ThingsMac"];
 if(apps.count!=1){out(@{@"state":@"unavailable",@"dispatched":@NO});return 0;}
 NSRunningApplication *app=apps.firstObject;
 pid_t pid=app.processIdentifier;
 struct proc_bsdinfo before={0},after={0};
 if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&before,sizeof(before))!=sizeof(before)||before.pbi_uid!=getuid()){out(@{@"state":@"unavailable",@"dispatched":@NO});return 0;}
 NSAppleEventDescriptor *target=[NSAppleEventDescriptor descriptorWithDescriptorType:typeKernelProcessID bytes:&pid length:sizeof(pid)];
 OSStatus permission=AEDeterminePermissionToAutomateTarget(target.aeDesc,kAECoreSuite,kAEGetData,false);
 if(permission!=noErr){out(@{@"state":@"permission_required",@"code":@(permission),@"dispatched":@NO});return 0;}
 // A property specifier for the documented version property of this process.
 NSAppleEventDescriptor *property=[NSAppleEventDescriptor recordDescriptor];
 [property setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:typeProperty] forKeyword:keyAEDesiredClass];
 [property setDescriptor:[NSAppleEventDescriptor nullDescriptor] forKeyword:keyAEContainer];
 [property setDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:formPropertyID] forKeyword:keyAEKeyForm];
 [property setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:'vers'] forKeyword:keyAEKeyData];
 NSAppleEventDescriptor *event=[NSAppleEventDescriptor appleEventWithEventClass:kAECoreSuite eventID:kAEGetData targetDescriptor:target returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
 [event setParamDescriptor:[property coerceToDescriptorType:typeObjectSpecifier] forKeyword:keyDirectObject];
 if(app.terminated||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after,sizeof(after))!=sizeof(after)||before.pbi_start_tvsec!=after.pbi_start_tvsec||before.pbi_start_tvusec!=after.pbi_start_tvusec){out(@{@"state":@"unavailable",@"dispatched":@NO});return 0;}
 NSError *error=nil;
 NSAppleEventDescriptor *reply=[event sendEventWithOptions:(kAEWaitReply|kAENeverInteract|kAEDontReconnect|kAEDoNotPromptForUserConsent) timeout:5 error:&error];
 if(!reply||[reply paramDescriptorForKeyword:keyErrorNumber].int32Value){out(@{@"state":@"read_failed",@"code":@(error ? error.code : [reply paramDescriptorForKeyword:keyErrorNumber].int32Value),@"dispatched":@YES});return 1;}
 out(@{@"state":@"ok",@"pid":@(pid),@"version":[reply paramDescriptorForKeyword:keyDirectObject].stringValue?:@"",@"dispatched":@YES});
 } return 0; }
